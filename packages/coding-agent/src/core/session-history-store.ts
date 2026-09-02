import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fdatasyncSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { AgentMessage, AgentMessageSource } from "@earendil-works/pi-agent-core";
import type {
	CursorPageOptions,
	FileEntry,
	SessionEntry,
	SessionHeader,
	SessionTreeNode,
	SessionTreePage,
	SessionTreePageEntry,
	SessionTreePageOptions,
} from "./session-manager.ts";
import { DatabaseSync, type StatementSync } from "./sqlite.ts";

const INDEX_APPLICATION_ID = 0x50494853; // PIHS
const SOURCE_LOCK_APPLICATION_ID = 0x50494c4b; // PILK
const INDEX_SCHEMA_VERSION = 7;
const READ_BUFFER_SIZE = 1024 * 1024;
const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_BYTES = 1024 * 1024;
const MAX_RETAINED_ACTIVE_ENTRIES = 8192;
const MAX_RETAINED_ACTIVE_BYTES = 8 * 1024 * 1024;
const TREE_PREVIEW_TEXT_BYTES = 3072;
const SOURCE_LOCK_WAIT_MS = 2 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 256;
const MAX_PAGE_LIMIT = 4096;

export interface NormalizedCursorPageOptions {
	afterOrdinal?: number;
	beforeOrdinal?: number;
	direction: "forward" | "reverse";
	limit: number;
}

/** Validate untrusted paging input once for in-memory, indexed, and RPC callers. */
export function normalizeCursorPageOptions(options: CursorPageOptions = {}): NormalizedCursorPageOptions {
	if (options.afterOrdinal !== undefined && options.beforeOrdinal !== undefined) {
		throw new Error("afterOrdinal and beforeOrdinal are mutually exclusive");
	}
	for (const [name, cursor] of [
		["afterOrdinal", options.afterOrdinal],
		["beforeOrdinal", options.beforeOrdinal],
	] as const) {
		if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
			throw new Error(`${name} must be a non-negative safe integer`);
		}
	}
	if (options.direction !== undefined && options.direction !== "forward" && options.direction !== "reverse") {
		throw new Error('direction must be "forward" or "reverse"');
	}
	const direction = options.direction ?? (options.beforeOrdinal === undefined ? "forward" : "reverse");
	if (direction === "forward" && options.beforeOrdinal !== undefined) {
		throw new Error("beforeOrdinal requires reverse direction");
	}
	if (direction === "reverse" && options.afterOrdinal !== undefined) {
		throw new Error("afterOrdinal requires forward direction");
	}
	if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
		throw new Error("limit must be a positive safe integer");
	}
	return {
		afterOrdinal: options.afterOrdinal,
		beforeOrdinal: options.beforeOrdinal,
		direction,
		limit: Math.min(options.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
	};
}

export interface EntryMetadata {
	ordinal: number;
	/** Zero-based ordinal among message entries, or undefined for non-message entries. */
	messageOrdinal?: number;
	id: string;
	parentId: string | null;
	type: string;
	customType?: string;
	timestamp: string;
	timestampMs?: number;
	offset: number;
	length: number;
	firstKeptEntryId?: string;
	nearestCompactionId?: string;
	labelTargetId?: string;
	label?: string;
	sessionName?: string;
	messageRole?: string;
	effectiveProvider?: string;
	effectiveModelId?: string;
	effectiveThinkingLevel: string;
	hasThinkingLevelChange: boolean;
}

export interface IterateEntriesOptions {
	type?: string;
	customType?: string;
	messageRole?: string;
	fromOrdinal?: number;
	toOrdinal?: number;
	direction?: "forward" | "reverse";
	limit?: number;
}

export interface EntryPageOptions extends Omit<IterateEntriesOptions, "direction" | "limit"> {
	afterOrdinal?: number;
	limit?: number;
}

export interface RecentActiveEntriesOptions
	extends Pick<IterateEntriesOptions, "type" | "customType" | "messageRole" | "limit"> {
	stopBeforeId?: string;
}

export interface SessionEntryPage {
	entries: SessionEntry[];
	nextOrdinal?: number;
}

export interface SessionHistoryMetrics {
	process_heap_used_bytes: number;
	process_external_bytes: number;
	process_rss_bytes: number;
	session_history_bytes: number;
	session_index_entries: number;
	session_active_entries: number;
	session_active_payload_bytes: number;
	session_hydration_cache_bytes: number;
	session_compaction_evicted_entries: number;
	session_compaction_evicted_bytes: number;
}

export interface SessionSourceIdentity {
	dev: number;
	ino: number;
}

/** Exact persisted prefix captured for a bounded, append-tolerant export. */
export interface SessionSourceSnapshot extends SessionSourceIdentity {
	byteLength: number;
	mtimeNs: string;
	ctimeNs: string;
	sha256: string;
}

export interface SessionHistorySummary {
	entryCount: number;
	compactionCount: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	totalMessages: number;
	toolCalls: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
	latestCacheHitRate?: number;
}

interface SourceStateRow {
	session_id: string;
	header_offset: number;
	header_length: number;
	source_dev: number | null;
	source_ino: number | null;
	source_mtime_ns: string;
	source_ctime_ns: string;
	indexed_length: number;
	entry_count: number;
	message_count: number;
	user_message_count: number;
	assistant_message_count: number;
	tool_result_count: number;
	tool_call_count: number;
	compaction_count: number;
	usage_input: number;
	usage_output: number;
	usage_cache_read: number;
	usage_cache_write: number;
	usage_cost: number;
	latest_cache_hit_rate: number | null;
	current_leaf_id: string | null;
	active_compaction_id: string | null;
	current_name: string | null;
	malformed_line_count: number;
	last_record_offset: number | null;
	last_record_length: number | null;
	last_record_sha256: Uint8Array | null;
	prefix_chain_sha256: Uint8Array;
	final_line_terminated: number;
}

interface EntryRow {
	ordinal: number;
	message_ordinal: number | null;
	id: string;
	parent_id: string | null;
	type: string;
	custom_type: string | null;
	timestamp: string;
	timestamp_ms: number | null;
	offset: number;
	length: number;
	ancestry_count: number;
	ancestry_payload_bytes: number;
	context_count: number;
	context_payload_bytes: number;
	first_kept_id: string | null;
	nearest_compaction_id: string | null;
	label_target_id: string | null;
	label_value: string | null;
	session_name: string | null;
	message_role: string | null;
	response_model: string | null;
	tool_call_count: number;
	usage_input: number;
	usage_output: number;
	usage_cache_read: number;
	usage_cache_write: number;
	usage_cost: number;
	effective_provider: string | null;
	effective_model_id: string | null;
	effective_thinking_level: string;
	has_thinking_level_change: number;
	tree_preview_json: string;
}

interface ScanResult {
	indexedLength: number;
	finalLineTerminated: boolean;
	malformedLines: number;
	lastRecordOffset?: number;
	lastRecordLength?: number;
	lastRecordSha256?: Buffer;
	prefixChainSha256: Buffer;
}

interface AggregateState {
	messageCount: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	toolCalls: number;
	compactionCount: number;
	usageInput: number;
	usageOutput: number;
	usageCacheRead: number;
	usageCacheWrite: number;
	usageCost: number;
	latestCacheHitRate: number | null;
}

function emptyAggregateState(): AggregateState {
	return {
		messageCount: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolResults: 0,
		toolCalls: 0,
		compactionCount: 0,
		usageInput: 0,
		usageOutput: 0,
		usageCacheRead: 0,
		usageCacheWrite: 0,
		usageCost: 0,
		latestCacheHitRate: null,
	};
}

function addRowToAggregate(aggregate: AggregateState, row: EntryRow): void {
	if (row.type === "message") {
		aggregate.messageCount++;
		if (row.message_role === "user") aggregate.userMessages++;
		else if (row.message_role === "assistant") aggregate.assistantMessages++;
		else if (row.message_role === "toolResult") aggregate.toolResults++;
	}
	if (row.type === "compaction") aggregate.compactionCount++;
	aggregate.toolCalls += row.tool_call_count;
	aggregate.usageInput += row.usage_input;
	aggregate.usageOutput += row.usage_output;
	aggregate.usageCacheRead += row.usage_cache_read;
	aggregate.usageCacheWrite += row.usage_cache_write;
	aggregate.usageCost += row.usage_cost;
	if (row.message_role === "assistant") {
		const promptTokens = row.usage_input + row.usage_cache_read + row.usage_cache_write;
		aggregate.latestCacheHitRate = promptTokens > 0 ? (row.usage_cache_read / promptTokens) * 100 : null;
	}
}

function aggregateFromSourceState(state: SourceStateRow): AggregateState {
	return {
		messageCount: state.message_count,
		userMessages: state.user_message_count,
		assistantMessages: state.assistant_message_count,
		toolResults: state.tool_result_count,
		toolCalls: state.tool_call_count,
		compactionCount: state.compaction_count,
		usageInput: state.usage_input,
		usageOutput: state.usage_output,
		usageCacheRead: state.usage_cache_read,
		usageCacheWrite: state.usage_cache_write,
		usageCost: state.usage_cost,
		latestCacheHitRate: state.latest_cache_hit_rate,
	};
}

interface IndexedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function indexedUsage(value: unknown): IndexedUsage | undefined {
	if (!isRecord(value)) return undefined;
	const number = (field: unknown): number => (typeof field === "number" && Number.isFinite(field) ? field : 0);
	return {
		input: number(value.input),
		output: number(value.output),
		cacheRead: number(value.cacheRead),
		cacheWrite: number(value.cacheWrite),
		cost: isRecord(value.cost) ? number(value.cost.total) : 0,
	};
}

function removeIfExists(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function isReadOnlyPathError(error: unknown): boolean {
	const candidate = error as NodeJS.ErrnoException & { errcode?: unknown };
	const code = candidate.code;
	return (
		code === "EACCES" ||
		code === "EPERM" ||
		code === "EROFS" ||
		(typeof code === "string" && (code.startsWith("SQLITE_READONLY") || code.startsWith("SQLITE_CANTOPEN"))) ||
		(code === "ERR_SQLITE_ERROR" &&
			typeof candidate.errcode === "number" &&
			((candidate.errcode & 0xff) === 8 || (candidate.errcode & 0xff) === 14))
	);
}

class IndexPathCollisionError extends Error {}
class SourceChangedDuringCatchUpError extends Error {}

function canonicalSessionPath(filePath: string): string {
	const canonical = realpathSync(filePath);
	if (statSync(canonical).nlink !== 1) {
		throw new Error(`Hard-linked session files are not supported: ${filePath}`);
	}
	return canonical;
}

let localSourceLockRoot: string | undefined;

function validateSourceLockRoot(root: string): string {
	const stats = lstatSync(root);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Unsafe session lock directory: ${root}`);
	}
	if (process.platform !== "win32" && typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Session lock directory is owned by another user: ${root}`);
	}
	if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
		throw new Error(`Session lock directory permissions are too broad: ${root}`);
	}
	return root;
}

function createSourceLockRoot(root: string, recursive = false): string {
	try {
		mkdirSync(root, { mode: 0o700, recursive });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return validateSourceLockRoot(root);
}

function getLocalSourceLockRoot(): string {
	if (localSourceLockRoot) return localSourceLockRoot;
	const uid = typeof process.getuid === "function" ? process.getuid() : "default";
	localSourceLockRoot = createSourceLockRoot(
		process.platform === "win32"
			? join(homedir(), ".pi-session-source-locks")
			: join("/tmp", `pi-session-source-locks-${uid}`),
		process.platform === "win32",
	);
	return localSourceLockRoot;
}

interface SharedSourceLockNamespace {
	root: string;
	identity: string;
}

function getSharedSourceLockNamespace(filePath: string): SharedSourceLockNamespace {
	if (process.platform === "win32") {
		const base = homedir();
		return {
			root: createSourceLockRoot(join(base, ".pi-session-source-locks"), true),
			identity: relative(base, filePath),
		};
	}
	const sourceDevice = statSync(filePath).dev;
	const candidates: string[] = [];
	let current = dirname(filePath);
	while (true) {
		if (statSync(current).dev !== sourceDevice) break;
		candidates.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const base of candidates.reverse()) {
		try {
			return {
				root: createSourceLockRoot(join(base, ".pi-session-source-locks")),
				identity: relative(base, filePath),
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS" && code !== "ENOENT") throw error;
		}
	}
	throw Object.assign(new Error(`No writable shared lock namespace for ${filePath}`), { code: "EACCES" });
}

function acquireSqliteSourceLock(lockPath: string, allowLegacySchema = false): () => void {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(lockPath);
		db.exec(`PRAGMA busy_timeout = ${SOURCE_LOCK_WAIT_MS}`);
		const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
		if (application.application_id === 0) {
			const schema = db
				.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as unknown as { name: string }[];
			const legacy = allowLegacySchema && schema.length === 1 && schema[0]?.name === "source_lock";
			if (schema.length !== 0 && !legacy) {
				throw new Error(`Refusing unrecognized session lock database: ${lockPath}`);
			}
			db.exec(`PRAGMA application_id = ${SOURCE_LOCK_APPLICATION_ID}`);
		} else if (application.application_id !== SOURCE_LOCK_APPLICATION_ID) {
			throw new Error(`Refusing unrecognized session lock database: ${lockPath}`);
		}
		chmodSync(lockPath, 0o600);
		db.exec(`
			PRAGMA journal_mode = DELETE;
			CREATE TABLE IF NOT EXISTS source_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));
			BEGIN EXCLUSIVE;
		`);
	} catch (error) {
		try {
			db?.close();
		} catch {}
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			db!.exec("COMMIT");
		} finally {
			db!.close();
		}
	};
}

export function acquireSourceLock(filePath: string, options: { allowLocalFallback?: boolean } = {}): () => void {
	const canonical = canonicalSessionPath(filePath);
	const localKey = createHash("sha256").update(canonical).digest("hex");
	try {
		const shared = getSharedSourceLockNamespace(canonical);
		const sharedKey = createHash("sha256").update(shared.identity).digest("hex");
		return acquireSqliteSourceLock(join(shared.root, `${sharedKey}.sqlite`));
	} catch (error) {
		if (options.allowLocalFallback && isReadOnlyPathError(error)) {
			return acquireSqliteSourceLock(join(getLocalSourceLockRoot(), `${localKey}.sqlite`), true);
		}
		throw Object.assign(new Error(`Unable to lock session file ${canonical}: ${String(error)}`), {
			code: "ELOCKED",
			cause: error,
		});
	}
}

function digest(bytes: Uint8Array): Buffer {
	return createHash("sha256").update(bytes).digest();
}

const NEWLINE = Buffer.from("\n");
const EMPTY_PREFIX_CHAIN = digest(Buffer.alloc(0));

function extendPrefixChain(previous: Uint8Array, bytes: Uint8Array, terminated: boolean): Buffer {
	const descriptor = Buffer.allocUnsafe(9);
	descriptor.writeBigUInt64BE(BigInt(bytes.length), 0);
	descriptor[8] = terminated ? 1 : 0;
	return createHash("sha256").update(previous).update(descriptor).update(bytes).digest();
}

function writeAllSync(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) throw new Error(`Unable to complete session write after ${offset} bytes`);
		offset += written;
	}
}

function readExactSync(fd: number, bytes: Uint8Array, position: number): boolean {
	let offset = 0;
	while (offset < bytes.length) {
		const read = readSync(fd, bytes, offset, bytes.length - offset, position + offset);
		if (read === 0) return false;
		offset += read;
	}
	return true;
}

interface SourceGeneration {
	dev: number;
	ino: number;
	mtimeNs: string;
	ctimeNs: string;
}

interface SourceDescriptorState extends SourceGeneration {
	size: number;
}

function sourceGeneration(filePath: string): SourceGeneration {
	const { size: _, ...generation } = sourcePathState(filePath);
	return generation;
}

function sourcePathState(filePath: string): SourceDescriptorState {
	const stats = statSync(filePath, { bigint: true });
	const size = Number(stats.size);
	if (!Number.isSafeInteger(size)) throw new Error("Session JSONL is too large to address safely");
	return {
		dev: Number(stats.dev),
		ino: Number(stats.ino),
		mtimeNs: stats.mtimeNs.toString(),
		ctimeNs: stats.ctimeNs.toString(),
		size,
	};
}

function sourceDescriptorState(fd: number): SourceDescriptorState {
	const stats = fstatSync(fd, { bigint: true });
	const size = Number(stats.size);
	if (!Number.isSafeInteger(size)) throw new Error("Session JSONL is too large to address safely");
	return {
		dev: Number(stats.dev),
		ino: Number(stats.ino),
		mtimeNs: stats.mtimeNs.toString(),
		ctimeNs: stats.ctimeNs.toString(),
		size,
	};
}

function sameDescriptorState(left: SourceDescriptorState, right: SourceDescriptorState): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.size === right.size
	);
}

function generationMatches(state: SourceStateRow, generation: SourceGeneration): boolean {
	return (
		(state.source_dev === null || state.source_dev === generation.dev) &&
		(state.source_ino === null || state.source_ino === generation.ino) &&
		state.source_mtime_ns === generation.mtimeNs &&
		state.source_ctime_ns === generation.ctimeNs
	);
}

function lastIndexedRecordMatches(state: SourceStateRow, filePath: string): boolean {
	if (state.last_record_offset === null || state.last_record_length === null || !state.last_record_sha256) return true;
	const fd = openSync(filePath, "r");
	try {
		const bytes = Buffer.allocUnsafe(state.last_record_length);
		return (
			readExactSync(fd, bytes, state.last_record_offset) &&
			digest(bytes).equals(Buffer.from(state.last_record_sha256))
		);
	} finally {
		closeSync(fd);
	}
}

function indexedPrefixMatches(state: SourceStateRow, filePath: string): boolean {
	try {
		const scan = scanPhysicalLines(filePath, 0, () => true, EMPTY_PREFIX_CHAIN, state.indexed_length);
		return (
			scan.indexedLength === state.indexed_length &&
			scan.finalLineTerminated &&
			scan.prefixChainSha256.equals(Buffer.from(state.prefix_chain_sha256))
		);
	} catch {
		return false;
	}
}

function isVerifiedIndexedPrefix(state: SourceStateRow, filePath: string, fileSize: number): boolean {
	return (
		fileSize >= state.indexed_length && state.final_line_terminated !== 0 && indexedPrefixMatches(state, filePath)
	);
}

function indexedDescriptorMatches(state: SourceStateRow, fd: number, filePath: string): boolean {
	try {
		if (sourceDescriptorState(fd).size < state.indexed_length) return false;
		const scan = scanPhysicalLinesFromDescriptor(
			fd,
			filePath,
			0,
			() => true,
			EMPTY_PREFIX_CHAIN,
			state.indexed_length,
		);
		return (
			scan.indexedLength === state.indexed_length &&
			scan.prefixChainSha256.equals(Buffer.from(state.prefix_chain_sha256))
		);
	} catch {
		return false;
	}
}

function openVerifiedIndexedDescriptor(
	state: SourceStateRow,
	filePath: string,
): { fd: number; generation: SourceDescriptorState } {
	for (let attempt = 0; attempt < 3; attempt++) {
		const fd = openSync(filePath, "r");
		try {
			const before = sourceDescriptorState(fd);
			if (indexedDescriptorMatches(state, fd, filePath)) {
				const after = sourceDescriptorState(fd);
				if (sameDescriptorState(before, after)) return { fd, generation: after };
			}
		} catch (error) {
			closeSync(fd);
			throw error;
		}
		closeSync(fd);
	}
	throw new SourceChangedDuringCatchUpError("Session JSONL changed while rebinding its indexed reader");
}

export function normalizeStoredAgentMessage(message: AgentMessage): AgentMessage {
	if (
		(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
		message.content == null
	) {
		return { ...message, content: [] } as AgentMessage;
	}
	return message;
}

function utf8Preview(text: string, maxBytes = TREE_PREVIEW_TEXT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const payloadBytes = Math.max(0, maxBytes - 3);
	let low = 0;
	let high = Math.min(text.length, payloadBytes);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= payloadBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
	return `${text.slice(0, end)}…`;
}

function previewContentText(content: unknown): string {
	if (typeof content === "string") return utf8Preview(content);
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		text = utf8Preview(text + block.text);
		if (Buffer.byteLength(text, "utf8") >= TREE_PREVIEW_TEXT_BYTES) break;
	}
	return text;
}

/** Create the bounded entry shape used by tree-page selectors. */
export function createTreePreviewEntry(entry: SessionEntry): SessionEntry {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message": {
			const message = entry.message as AgentMessage & Record<string, unknown>;
			const preview: Record<string, unknown> = {
				role: message.role,
				timestamp: message.timestamp,
			};
			if ("content" in message) preview.content = previewContentText(message.content);
			for (const field of ["stopReason", "toolCallId", "toolName", "isError"] as const) {
				if (field in message) preview[field] = message[field];
			}
			if (typeof message.errorMessage === "string") preview.errorMessage = utf8Preview(message.errorMessage, 512);
			if (typeof message.command === "string") preview.command = utf8Preview(message.command);
			return { ...base, type: "message", message: preview as unknown as AgentMessage };
		}
		case "custom_message":
			return {
				...base,
				type: "custom_message",
				customType: utf8Preview(entry.customType, 256),
				content: previewContentText(entry.content),
				display: entry.display,
			};
		case "compaction":
			return {
				...base,
				type: "compaction",
				summary: utf8Preview(entry.summary),
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
			};
		case "branch_summary":
			return {
				...base,
				type: "branch_summary",
				fromId: entry.fromId,
				summary: utf8Preview(entry.summary),
			};
		case "model_change":
			return {
				...base,
				type: "model_change",
				provider: utf8Preview(entry.provider, 256),
				modelId: utf8Preview(entry.modelId, 256),
			};
		case "thinking_level_change":
			return { ...base, type: "thinking_level_change", thinkingLevel: utf8Preview(entry.thinkingLevel, 256) };
		case "custom":
			return { ...base, type: "custom", customType: utf8Preview(entry.customType, 256) };
		case "label":
			return {
				...base,
				type: "label",
				targetId: entry.targetId,
				label: entry.label === undefined ? undefined : utf8Preview(entry.label, 512),
			};
		case "session_info":
			return {
				...base,
				type: "session_info",
				name: entry.name === undefined ? undefined : utf8Preview(entry.name, 512),
			};
	}
}

function parseFileEntry(bytes: Buffer): FileEntry | null {
	const text = bytes.toString("utf8");
	if (text.trim() === "") return null;
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== "object") return null;
		return value as FileEntry;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session" && typeof (entry as { id?: unknown }).id === "string";
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
	const candidate = entry as Partial<SessionEntry>;
	if (
		entry.type !== "session" &&
		typeof candidate.id === "string" &&
		(candidate.parentId === null || typeof candidate.parentId === "string") &&
		typeof candidate.timestamp === "string"
	) {
		switch (entry.type) {
			case "message": {
				const message = (entry as { message?: unknown }).message;
				return isRecord(message) && typeof message.role === "string";
			}
			case "thinking_level_change":
				return typeof (entry as { thinkingLevel?: unknown }).thinkingLevel === "string";
			case "model_change":
				return (
					typeof (entry as { provider?: unknown }).provider === "string" &&
					typeof (entry as { modelId?: unknown }).modelId === "string"
				);
			case "compaction":
				return (
					typeof (entry as { summary?: unknown }).summary === "string" &&
					typeof (entry as { firstKeptEntryId?: unknown }).firstKeptEntryId === "string" &&
					typeof (entry as { tokensBefore?: unknown }).tokensBefore === "number"
				);
			case "branch_summary":
				return (
					typeof (entry as { fromId?: unknown }).fromId === "string" &&
					typeof (entry as { summary?: unknown }).summary === "string"
				);
			case "custom":
				return typeof (entry as { customType?: unknown }).customType === "string";
			case "custom_message": {
				const custom = entry as { customType?: unknown; content?: unknown; display?: unknown };
				return (
					typeof custom.customType === "string" &&
					(custom.content == null || typeof custom.content === "string" || Array.isArray(custom.content)) &&
					typeof custom.display === "boolean"
				);
			}
			case "label": {
				const label = entry as { targetId?: unknown; label?: unknown };
				return typeof label.targetId === "string" && (label.label === undefined || typeof label.label === "string");
			}
			case "session_info": {
				const name = (entry as { name?: unknown }).name;
				return name === undefined || typeof name === "string";
			}
			default:
				return true;
		}
	}
	return false;
}

function scanPhysicalLinesFromDescriptor(
	fd: number,
	filePath: string,
	startOffset: number,
	visitor: (bytes: Buffer, offset: number, terminated: boolean) => boolean,
	initialPrefixChain: Uint8Array = EMPTY_PREFIX_CHAIN,
	endOffset?: number,
): ScanResult {
	let absoluteOffset = startOffset;
	let lineOffset = startOffset;
	let pendingParts: Buffer[] = [];
	let pendingLength = 0;
	let malformedLines = 0;
	let lastRecordOffset: number | undefined;
	let lastRecordLength: number | undefined;
	let lastRecordSha256: Buffer | undefined;
	let finalLineTerminated = true;
	let prefixChainSha256: Buffer<ArrayBufferLike> = Buffer.from(initialPrefixChain);

	const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
	while (true) {
		if (endOffset !== undefined && absoluteOffset >= endOffset) break;
		const readLength = endOffset === undefined ? buffer.length : Math.min(buffer.length, endOffset - absoluteOffset);
		const bytesRead = readSync(fd, buffer, 0, readLength, absoluteOffset);
		if (bytesRead === 0) break;
		absoluteOffset += bytesRead;
		const chunk = buffer.subarray(0, bytesRead);
		let cursor = 0;
		let newline = chunk.indexOf(0x0a, cursor);
		while (newline !== -1) {
			const tail = chunk.subarray(cursor, newline);
			if (pendingLength + tail.length > MAX_SESSION_RECORD_BYTES) {
				throw new Error(`Session record exceeds ${MAX_SESSION_RECORD_BYTES} bytes: ${filePath}`);
			}
			let line = tail;
			if (pendingLength > 0) {
				pendingParts.push(tail);
				line = Buffer.concat(pendingParts, pendingLength + tail.length);
				pendingParts = [];
				pendingLength = 0;
			}
			if (!visitor(line, lineOffset, true)) malformedLines++;
			prefixChainSha256 = extendPrefixChain(prefixChainSha256, line, true);
			lastRecordOffset = lineOffset;
			lastRecordLength = line.length;
			lastRecordSha256 = digest(line);
			lineOffset += line.length + 1;
			cursor = newline + 1;
			newline = chunk.indexOf(0x0a, cursor);
		}
		if (cursor < chunk.length) {
			const tail = Buffer.from(chunk.subarray(cursor));
			if (pendingLength + tail.length > MAX_SESSION_RECORD_BYTES) {
				throw new Error(`Session record exceeds ${MAX_SESSION_RECORD_BYTES} bytes: ${filePath}`);
			}
			pendingParts.push(tail);
			pendingLength += tail.length;
		}
	}

	if (pendingLength > 0) {
		const pending = pendingParts.length === 1 ? pendingParts[0] : Buffer.concat(pendingParts, pendingLength);
		finalLineTerminated = false;
		if (visitor(pending, lineOffset, false)) {
			prefixChainSha256 = extendPrefixChain(prefixChainSha256, pending, false);
			lastRecordOffset = lineOffset;
			lastRecordLength = pending.length;
			lastRecordSha256 = digest(pending);
			lineOffset += pending.length;
		} else {
			malformedLines++;
		}
	}

	return {
		indexedLength: lineOffset,
		finalLineTerminated,
		malformedLines,
		lastRecordOffset,
		lastRecordLength,
		lastRecordSha256,
		prefixChainSha256,
	};
}

function scanPhysicalLines(
	filePath: string,
	startOffset: number,
	visitor: (bytes: Buffer, offset: number, terminated: boolean) => boolean,
	initialPrefixChain: Uint8Array = EMPTY_PREFIX_CHAIN,
	endOffset?: number,
): ScanResult {
	const fd = openSync(filePath, "r");
	try {
		return scanPhysicalLinesFromDescriptor(fd, filePath, startOffset, visitor, initialPrefixChain, endOffset);
	} finally {
		closeSync(fd);
	}
}

function initializeDatabase(db: DatabaseSync): void {
	db.exec(`
		PRAGMA application_id = ${INDEX_APPLICATION_ID};
		PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
		PRAGMA journal_mode = DELETE;
	`);
	configureConnection(db);
	db.exec(`
		CREATE TABLE source_state (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			session_id TEXT NOT NULL,
			header_offset INTEGER NOT NULL,
			header_length INTEGER NOT NULL,
				source_dev INTEGER,
				source_ino INTEGER,
				source_mtime_ns TEXT NOT NULL,
				source_ctime_ns TEXT NOT NULL,
				indexed_length INTEGER NOT NULL,
			entry_count INTEGER NOT NULL,
			message_count INTEGER NOT NULL,
			user_message_count INTEGER NOT NULL,
			assistant_message_count INTEGER NOT NULL,
			tool_result_count INTEGER NOT NULL,
			tool_call_count INTEGER NOT NULL,
			compaction_count INTEGER NOT NULL,
			usage_input INTEGER NOT NULL,
			usage_output INTEGER NOT NULL,
			usage_cache_read INTEGER NOT NULL,
			usage_cache_write INTEGER NOT NULL,
			usage_cost REAL NOT NULL,
			latest_cache_hit_rate REAL,
			current_leaf_id TEXT,
			active_compaction_id TEXT,
			current_name TEXT,
			malformed_line_count INTEGER NOT NULL DEFAULT 0,
			last_record_offset INTEGER,
			last_record_length INTEGER,
			last_record_sha256 BLOB,
			prefix_chain_sha256 BLOB NOT NULL,
			final_line_terminated INTEGER NOT NULL
		);

		CREATE TABLE entries (
			ordinal INTEGER PRIMARY KEY,
			message_ordinal INTEGER,
			id TEXT NOT NULL,
			parent_id TEXT,
			type TEXT NOT NULL,
			custom_type TEXT,
			timestamp TEXT NOT NULL,
			timestamp_ms INTEGER,
			offset INTEGER NOT NULL,
			length INTEGER NOT NULL,
			ancestry_count INTEGER NOT NULL,
			ancestry_payload_bytes INTEGER NOT NULL,
			context_count INTEGER NOT NULL,
			context_payload_bytes INTEGER NOT NULL,
			first_kept_id TEXT,
			nearest_compaction_id TEXT,
			label_target_id TEXT,
			label_value TEXT,
			session_name TEXT,
			message_role TEXT,
			response_model TEXT,
			tool_call_count INTEGER NOT NULL,
			usage_input INTEGER NOT NULL,
			usage_output INTEGER NOT NULL,
			usage_cache_read INTEGER NOT NULL,
			usage_cache_write INTEGER NOT NULL,
			usage_cost REAL NOT NULL,
			effective_provider TEXT,
			effective_model_id TEXT,
			effective_thinking_level TEXT NOT NULL,
			has_thinking_level_change INTEGER NOT NULL,
			tree_preview_json TEXT NOT NULL
		);

		CREATE INDEX entries_id ON entries(id, ordinal DESC);
		CREATE INDEX entries_parent ON entries(parent_id, timestamp_ms, ordinal);
		CREATE INDEX entries_type ON entries(type, ordinal);
		CREATE UNIQUE INDEX entries_message_ordinal ON entries(message_ordinal) WHERE message_ordinal IS NOT NULL;
		CREATE INDEX entries_custom ON entries(custom_type, ordinal);

		CREATE TABLE current_labels (
			target_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			label_entry_id TEXT NOT NULL,
			label_timestamp TEXT NOT NULL,
			label_ordinal INTEGER NOT NULL
		);
	`);
}

function configureConnection(db: DatabaseSync): void {
	db.exec(`
		PRAGMA synchronous = FULL;
		PRAGMA temp_store = FILE;
		PRAGMA mmap_size = 0;
		PRAGMA cache_size = -4096;
		PRAGMA busy_timeout = 5000;
	`);
}

interface EntryStatements {
	byId: StatementSync;
	byOrdinal: StatementSync;
	insert: StatementSync;
	upsertLabel: StatementSync;
	deleteLabel: StatementSync;
}

function prepareEntryStatements(db: DatabaseSync): EntryStatements {
	return {
		byId: db.prepare("SELECT * FROM entries WHERE id = ? ORDER BY ordinal DESC LIMIT 1"),
		byOrdinal: db.prepare("SELECT * FROM entries WHERE ordinal = ?"),
		insert: db.prepare(`
			INSERT INTO entries (
				ordinal, message_ordinal, id, parent_id, type, custom_type, timestamp, timestamp_ms, offset, length,
				ancestry_count, ancestry_payload_bytes, context_count, context_payload_bytes,
				first_kept_id, nearest_compaction_id, label_target_id, label_value, session_name,
				message_role, response_model, tool_call_count, usage_input, usage_output,
				usage_cache_read, usage_cache_write, usage_cost, effective_provider,
				effective_model_id, effective_thinking_level, has_thinking_level_change, tree_preview_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		upsertLabel: db.prepare(`
			INSERT INTO current_labels (target_id, label, label_entry_id, label_timestamp, label_ordinal)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(target_id) DO UPDATE SET
				label = excluded.label,
				label_entry_id = excluded.label_entry_id,
				label_timestamp = excluded.label_timestamp,
				label_ordinal = excluded.label_ordinal
		`),
		deleteLabel: db.prepare("DELETE FROM current_labels WHERE target_id = ?"),
	};
}

function toMetadata(row: EntryRow): EntryMetadata {
	return {
		ordinal: row.ordinal,
		messageOrdinal: row.message_ordinal ?? undefined,
		id: row.id,
		parentId: row.parent_id,
		type: row.type,
		customType: row.custom_type ?? undefined,
		timestamp: row.timestamp,
		timestampMs: row.timestamp_ms ?? undefined,
		offset: row.offset,
		length: row.length,
		firstKeptEntryId: row.first_kept_id ?? undefined,
		nearestCompactionId: row.nearest_compaction_id ?? undefined,
		labelTargetId: row.label_target_id ?? undefined,
		label: row.label_value ?? undefined,
		sessionName: row.session_name ?? undefined,
		messageRole: row.message_role ?? undefined,
		effectiveProvider: row.effective_provider ?? undefined,
		effectiveModelId: row.effective_model_id ?? undefined,
		effectiveThinkingLevel: row.effective_thinking_level,
		hasThinkingLevelChange: row.has_thinking_level_change !== 0,
	};
}

function entryMatchesMetadata(entry: SessionEntry, metadata: EntryMetadata): boolean {
	if (
		entry.id !== metadata.id ||
		entry.parentId !== metadata.parentId ||
		entry.type !== metadata.type ||
		entry.timestamp !== metadata.timestamp
	) {
		return false;
	}
	if (entry.type === "message" && entry.message.role !== metadata.messageRole) return false;
	if (entry.type === "compaction" && entry.firstKeptEntryId !== metadata.firstKeptEntryId) return false;
	if ((entry.type === "custom" || entry.type === "custom_message") && entry.customType !== metadata.customType) {
		return false;
	}
	if (entry.type === "label" && (entry.targetId !== metadata.labelTargetId || entry.label !== metadata.label)) {
		return false;
	}
	if (entry.type === "session_info" && entry.name !== metadata.sessionName) return false;
	return true;
}

function lastMessageForRole(messages: AgentMessage[], role?: AgentMessage["role"]): AgentMessage | undefined {
	if (role === undefined) return messages.at(-1);
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === role) return messages[index];
	}
	return undefined;
}

function metadataProjectsRole(metadata: EntryMetadata, role?: AgentMessage["role"]): boolean {
	if (role === undefined) {
		return (
			metadata.type === "message" ||
			metadata.type === "custom_message" ||
			metadata.type === "branch_summary" ||
			metadata.type === "compaction"
		);
	}
	if (metadata.type === "message") return metadata.messageRole === role;
	if (metadata.type === "custom_message") return role === "custom";
	if (metadata.type === "branch_summary") return role === "branchSummary";
	if (metadata.type === "compaction") return role === "compactionSummary";
	return false;
}

class ByteLru {
	private readonly values = new Map<number, { entry: SessionEntry; bytes: number }>();
	private readonly budgetBytes: number;
	private chargedBytes = 0;

	constructor(budgetBytes: number) {
		this.budgetBytes = budgetBytes;
	}

	get bytes(): number {
		return this.chargedBytes;
	}

	get(ordinal: number): SessionEntry | undefined {
		const cached = this.values.get(ordinal);
		if (!cached) return undefined;
		this.values.delete(ordinal);
		this.values.set(ordinal, cached);
		return cached.entry;
	}

	set(ordinal: number, entry: SessionEntry, bytes: number): void {
		if (bytes > this.budgetBytes) return;
		const previous = this.values.get(ordinal);
		if (previous) {
			this.chargedBytes -= previous.bytes;
			this.values.delete(ordinal);
		}
		this.values.set(ordinal, { entry, bytes });
		this.chargedBytes += bytes;
		while (this.chargedBytes > this.budgetBytes) {
			const oldest = this.values.entries().next();
			if (oldest.done) break;
			this.values.delete(oldest.value[0]);
			this.chargedBytes -= oldest.value[1].bytes;
		}
	}

	evict(predicate: (ordinal: number) => boolean): { entries: number; bytes: number } {
		let entries = 0;
		let bytes = 0;
		for (const [ordinal, value] of this.values) {
			if (!predicate(ordinal)) continue;
			this.values.delete(ordinal);
			this.chargedBytes -= value.bytes;
			entries++;
			bytes += value.bytes;
		}
		return { entries, bytes };
	}

	clear(): void {
		this.values.clear();
		this.chargedBytes = 0;
	}
}

export class IndexedJsonlSessionHistoryStore {
	readonly filePath: string;
	readonly indexPath: string;
	readonly header: SessionHeader;

	private db: DatabaseSync;
	private readonly entryStatements: EntryStatements;
	private readonly sourceStateStatement: StatementSync;
	private readonly messageByOrdinalStatement: StatementSync;
	private readonly labelByTargetStatement: StatementSync;
	private sourceFd: number | undefined;
	private readonly cache: ByteLru;
	private activeByOrdinal = new Map<number, SessionEntry>();
	private activeOrdinals = new Set<number>();
	private activeLengths = new Map<number, number>();
	private activeEntryCount = 0;
	private activePayloadBytes = 0;
	private activeProjectionRetained = true;
	private activeVisitorMetadata: EntryMetadata | undefined;
	private activeVisitorEntry: SessionEntry | undefined;
	private evictedEntries = 0;
	private evictedBytes = 0;
	private volatileLeafId: string | null;
	private readonly temporaryIndexRoot?: string;
	private closed = false;

	private constructor(
		filePath: string,
		indexPath: string,
		db: DatabaseSync,
		sourceFd: number,
		header: SessionHeader,
		cacheBytes: number,
		temporaryIndexRoot?: string,
	) {
		this.filePath = filePath;
		this.indexPath = indexPath;
		this.db = db;
		this.entryStatements = prepareEntryStatements(db);
		this.sourceStateStatement = db.prepare("SELECT * FROM source_state WHERE singleton = 1");
		this.messageByOrdinalStatement = db.prepare("SELECT * FROM entries WHERE message_ordinal = ?");
		this.labelByTargetStatement = db.prepare("SELECT label, label_timestamp FROM current_labels WHERE target_id = ?");
		this.sourceFd = sourceFd;
		this.header = header;
		this.cache = new ByteLru(cacheBytes);
		this.temporaryIndexRoot = temporaryIndexRoot;
		this.volatileLeafId = this.sourceState().current_leaf_id;
		this.refreshActiveProjection();
	}

	static open(filePath: string, cacheBytes = DEFAULT_CACHE_BYTES): IndexedJsonlSessionHistoryStore {
		if (!existsSync(filePath)) throw new Error(`Session file does not exist: ${filePath}`);
		const canonical = canonicalSessionPath(filePath);
		let release: (() => void) | undefined;
		try {
			release = acquireSourceLock(canonical, { allowLocalFallback: true });
			return IndexedJsonlSessionHistoryStore.openWithIndex(canonical, `${canonical}.index.sqlite`, cacheBytes);
		} catch (error) {
			if (!(error instanceof IndexPathCollisionError) && !isReadOnlyPathError(error)) throw error;
			const temporaryIndexRoot = mkdtempSync(join(tmpdir(), "pi-session-index-"));
			try {
				return IndexedJsonlSessionHistoryStore.openWithIndex(
					canonical,
					join(temporaryIndexRoot, "history.index.sqlite"),
					cacheBytes,
					temporaryIndexRoot,
				);
			} catch (temporaryError) {
				rmSync(temporaryIndexRoot, { recursive: true, force: true });
				throw temporaryError;
			}
		} finally {
			release?.();
		}
	}

	private static openWithIndex(
		filePath: string,
		indexPath: string,
		cacheBytes: number,
		temporaryIndexRoot?: string,
	): IndexedJsonlSessionHistoryStore {
		let db: DatabaseSync | undefined;
		let sourceFd: number | undefined;
		try {
			if (existsSync(indexPath)) {
				try {
					db = new DatabaseSync(indexPath);
					const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
					if (application.application_id !== INDEX_APPLICATION_ID) {
						throw new IndexPathCollisionError(`Refusing to replace unrecognized index path: ${indexPath}`);
					}
				} catch (error) {
					try {
						db?.close();
					} catch {}
					db = undefined;
					if (error instanceof IndexPathCollisionError) throw error;
					throw new IndexPathCollisionError(`Refusing to replace unrecognized index path: ${indexPath}`, {
						cause: error,
					});
				}
				if (!IndexedJsonlSessionHistoryStore.indexIsUsable(db, filePath)) {
					db.close();
					db = undefined;
					removeIfExists(indexPath);
				} else {
					configureConnection(db);
				}
			}
			if (!db) {
				IndexedJsonlSessionHistoryStore.rebuild(filePath, indexPath);
				db = new DatabaseSync(indexPath);
				configureConnection(db);
			}
			IndexedJsonlSessionHistoryStore.catchUp(db, filePath);
			const header = IndexedJsonlSessionHistoryStore.readHeader(db, filePath);
			db.exec("PRAGMA shrink_memory");
			sourceFd = openSync(filePath, "r");
			const store = new IndexedJsonlSessionHistoryStore(
				filePath,
				indexPath,
				db,
				sourceFd,
				header,
				cacheBytes,
				temporaryIndexRoot,
			);
			db = undefined;
			sourceFd = undefined;
			return store;
		} catch (error) {
			try {
				if (sourceFd !== undefined) closeSync(sourceFd);
			} finally {
				db?.close();
			}
			throw error;
		}
	}

	private static indexIsUsable(db: DatabaseSync, filePath: string): boolean {
		try {
			const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
			const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
			const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
			if (
				application.application_id !== INDEX_APPLICATION_ID ||
				version.user_version !== INDEX_SCHEMA_VERSION ||
				integrity.quick_check !== "ok"
			) {
				return false;
			}
			const tables = new Set(
				(
					db
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('source_state', 'entries', 'current_labels')",
						)
						.all() as Array<{ name: string }>
				).map(({ name }) => name),
			);
			if (!["source_state", "entries", "current_labels"].every((name) => tables.has(name))) return false;
			prepareEntryStatements(db);
			db.prepare("SELECT label, label_timestamp FROM current_labels WHERE target_id = ?");
			const state = db.prepare("SELECT * FROM source_state WHERE singleton = 1").get() as SourceStateRow | undefined;
			if (!state) return false;
			const stats = statSync(filePath);
			const safeRange = (offset: unknown, length: unknown, end: number): boolean =>
				typeof offset === "number" &&
				Number.isSafeInteger(offset) &&
				offset >= 0 &&
				typeof length === "number" &&
				Number.isSafeInteger(length) &&
				length >= 0 &&
				length <= MAX_SESSION_RECORD_BYTES &&
				offset <= end &&
				length <= end - offset;
			if (
				!Number.isSafeInteger(state.indexed_length) ||
				state.indexed_length < 0 ||
				!Number.isSafeInteger(state.entry_count) ||
				state.entry_count < 0 ||
				!safeRange(state.header_offset, state.header_length, state.indexed_length) ||
				state.prefix_chain_sha256.byteLength !== 32 ||
				(state.last_record_sha256 !== null && state.last_record_sha256.byteLength !== 32) ||
				(state.last_record_offset !== null &&
					!safeRange(state.last_record_offset, state.last_record_length, state.indexed_length))
			) {
				return false;
			}
			const header = IndexedJsonlSessionHistoryStore.readHeader(db, filePath);
			if (header.id !== state.session_id) return false;
			const invalidEntry = db
				.prepare(
					`SELECT 1 AS invalid FROM entries
					 WHERE offset < 0 OR length < 0 OR length > ${MAX_SESSION_RECORD_BYTES}
					    OR offset > ? OR length > ? - offset
					 LIMIT 1`,
				)
				.get(state.indexed_length, state.indexed_length);
			if (invalidEntry) return false;
			const counts = db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number };
			if (counts.count !== state.entry_count) return false;
			if (stats.size < state.indexed_length) return false;
			const generation = sourceGeneration(filePath);
			if (stats.size === state.indexed_length) {
				return generationMatches(state, generation)
					? lastIndexedRecordMatches(state, filePath)
					: isVerifiedIndexedPrefix(state, filePath, stats.size);
			}
			return isVerifiedIndexedPrefix(state, filePath, stats.size);
		} catch {
			return false;
		}
	}

	private static rebuild(filePath: string, indexPath: string): void {
		const temporaryPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
		removeIfExists(temporaryPath);
		const db = new DatabaseSync(temporaryPath);
		try {
			chmodSync(temporaryPath, 0o600);
			initializeDatabase(db);
			db.exec("BEGIN IMMEDIATE");
			const statements = prepareEntryStatements(db);
			const generation = sourceGeneration(filePath);
			let header: SessionHeader | undefined;
			let headerOffset = 0;
			let headerLength = 0;
			let ordinal = 0;
			let currentLeafId: string | null = null;
			let activeCompactionId: string | null = null;
			let currentName: string | null = null;
			const aggregate = emptyAggregateState();
			const scan = scanPhysicalLines(filePath, 0, (bytes, offset) => {
				const parsed = parseFileEntry(bytes);
				if (!parsed) return bytes.toString("utf8").trim() === "";
				if (!header) {
					if (!isSessionHeader(parsed)) throw new Error(`Session file is not a valid pi session: ${filePath}`);
					header = parsed;
					headerOffset = offset;
					headerLength = bytes.length;
					return true;
				}
				if (!isSessionEntry(parsed)) return false;
				const row = IndexedJsonlSessionHistoryStore.insertEntry(
					statements,
					parsed,
					ordinal++,
					aggregate.messageCount,
					offset,
					bytes.length,
				);
				addRowToAggregate(aggregate, row);
				currentLeafId = row.id;
				activeCompactionId = row.nearest_compaction_id;
				if (row.type === "session_info") currentName = row.session_name;
				return true;
			});
			if (!header) throw new Error(`Session file is not a valid pi session: ${filePath}`);
			db.prepare(`
				INSERT INTO source_state (
					singleton, session_id, header_offset, header_length, source_dev, source_ino,
					source_mtime_ns, source_ctime_ns,
					indexed_length, entry_count, message_count, user_message_count,
					assistant_message_count, tool_result_count, tool_call_count, compaction_count,
					usage_input, usage_output, usage_cache_read, usage_cache_write, usage_cost,
					latest_cache_hit_rate, current_leaf_id, active_compaction_id, current_name,
					malformed_line_count, last_record_offset, last_record_length, last_record_sha256,
					prefix_chain_sha256, final_line_terminated
				) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				header.id,
				headerOffset,
				headerLength,
				generation.dev,
				generation.ino,
				generation.mtimeNs,
				generation.ctimeNs,
				scan.indexedLength,
				ordinal,
				aggregate.messageCount,
				aggregate.userMessages,
				aggregate.assistantMessages,
				aggregate.toolResults,
				aggregate.toolCalls,
				aggregate.compactionCount,
				aggregate.usageInput,
				aggregate.usageOutput,
				aggregate.usageCacheRead,
				aggregate.usageCacheWrite,
				aggregate.usageCost,
				aggregate.latestCacheHitRate,
				currentLeafId,
				activeCompactionId,
				currentName,
				scan.malformedLines,
				scan.lastRecordOffset ?? null,
				scan.lastRecordLength ?? null,
				scan.lastRecordSha256 ?? null,
				scan.prefixChainSha256,
				scan.finalLineTerminated ? 1 : 0,
			);
			db.exec("COMMIT");
			db.close();
			renameSync(temporaryPath, indexPath);
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			try {
				db.close();
			} catch {}
			removeIfExists(temporaryPath);
			throw error;
		}
	}

	private static catchUp(db: DatabaseSync, filePath: string, controlledSourceGrowth = false, retry = 0): void {
		db.exec("BEGIN IMMEDIATE");
		try {
			const state = db.prepare("SELECT * FROM source_state WHERE singleton = 1").get() as unknown as SourceStateRow;
			const source = sourcePathState(filePath);
			const generation: SourceGeneration = source;
			if (
				!generationMatches(state, generation) &&
				!controlledSourceGrowth &&
				!isVerifiedIndexedPrefix(state, filePath, source.size)
			) {
				throw new Error(
					"Session JSONL changed outside the indexed writer; close and reopen it to rebuild the index",
				);
			}
			if (source.size === state.indexed_length) {
				db.prepare(`
					UPDATE source_state
					SET source_dev = ?, source_ino = ?, source_mtime_ns = ?, source_ctime_ns = ?
					WHERE singleton = 1
				`).run(generation.dev, generation.ino, generation.mtimeNs, generation.ctimeNs);
				db.exec("COMMIT");
				return;
			}
			if (source.size < state.indexed_length) throw new Error("Session JSONL shrank behind its index");
			let ordinal = state.entry_count;
			let currentLeafId = state.current_leaf_id;
			let activeCompactionId = state.active_compaction_id;
			let currentName = state.current_name;
			const aggregate = aggregateFromSourceState(state);
			const statements = prepareEntryStatements(db);
			const scan = scanPhysicalLines(
				filePath,
				state.indexed_length,
				(bytes, offset) => {
					const parsed = parseFileEntry(bytes);
					if (!parsed) return bytes.toString("utf8").trim() === "";
					if (!isSessionEntry(parsed)) return false;
					const row = IndexedJsonlSessionHistoryStore.insertEntry(
						statements,
						parsed,
						ordinal++,
						aggregate.messageCount,
						offset,
						bytes.length,
					);
					addRowToAggregate(aggregate, row);
					currentLeafId = row.id;
					activeCompactionId = row.nearest_compaction_id;
					if (row.type === "session_info") currentName = row.session_name;
					return true;
				},
				state.prefix_chain_sha256,
				source.size,
			);
			const prefixChainSha256 =
				state.final_line_terminated === 0
					? scanPhysicalLines(filePath, 0, () => true, EMPTY_PREFIX_CHAIN, scan.indexedLength).prefixChainSha256
					: scan.prefixChainSha256;
			if (!sameDescriptorState(source, sourcePathState(filePath))) {
				throw new SourceChangedDuringCatchUpError("Session JSONL changed while extending its index");
			}
			db.prepare(`
				UPDATE source_state SET
					source_dev = ?, source_ino = ?, source_mtime_ns = ?, source_ctime_ns = ?,
					indexed_length = ?, entry_count = ?, message_count = ?, user_message_count = ?,
					assistant_message_count = ?, tool_result_count = ?, tool_call_count = ?,
					compaction_count = ?, usage_input = ?, usage_output = ?, usage_cache_read = ?,
					usage_cache_write = ?, usage_cost = ?, latest_cache_hit_rate = ?,
					current_leaf_id = ?, active_compaction_id = ?,
					current_name = ?, malformed_line_count = malformed_line_count + ?,
					last_record_offset = ?, last_record_length = ?, last_record_sha256 = ?,
					prefix_chain_sha256 = ?, final_line_terminated = ?
				WHERE singleton = 1
			`).run(
				generation.dev,
				generation.ino,
				generation.mtimeNs,
				generation.ctimeNs,
				scan.indexedLength,
				ordinal,
				aggregate.messageCount,
				aggregate.userMessages,
				aggregate.assistantMessages,
				aggregate.toolResults,
				aggregate.toolCalls,
				aggregate.compactionCount,
				aggregate.usageInput,
				aggregate.usageOutput,
				aggregate.usageCacheRead,
				aggregate.usageCacheWrite,
				aggregate.usageCost,
				aggregate.latestCacheHitRate,
				currentLeafId,
				activeCompactionId,
				currentName,
				scan.malformedLines,
				scan.lastRecordOffset ?? state.last_record_offset,
				scan.lastRecordLength ?? state.last_record_length,
				scan.lastRecordSha256 ?? state.last_record_sha256,
				prefixChainSha256,
				scan.finalLineTerminated ? 1 : 0,
			);
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			if (error instanceof SourceChangedDuringCatchUpError && retry < 2) {
				IndexedJsonlSessionHistoryStore.catchUp(db, filePath, controlledSourceGrowth, retry + 1);
				return;
			}
			throw error;
		}
	}

	private static readHeader(db: DatabaseSync, filePath: string): SessionHeader {
		const state = db.prepare("SELECT * FROM source_state WHERE singleton = 1").get() as unknown as SourceStateRow;
		const fd = openSync(filePath, "r");
		try {
			const bytes = Buffer.allocUnsafe(state.header_length);
			if (!readExactSync(fd, bytes, state.header_offset)) {
				throw new Error(`Unable to read session header: ${filePath}`);
			}
			const entry = parseFileEntry(bytes);
			if (!entry || !isSessionHeader(entry)) throw new Error(`Invalid session header: ${filePath}`);
			return entry;
		} finally {
			closeSync(fd);
		}
	}

	private static insertEntry(
		statements: EntryStatements,
		entry: SessionEntry,
		ordinal: number,
		messageOrdinal: number,
		offset: number,
		length: number,
	): EntryRow {
		const parent = entry.parentId ? (statements.byId.get(entry.parentId) as EntryRow | undefined) : undefined;
		let effectiveProvider = parent?.effective_provider ?? null;
		let effectiveModelId = parent?.effective_model_id ?? null;
		let effectiveThinkingLevel = parent?.effective_thinking_level ?? "off";
		let hasThinkingLevelChange = (parent?.has_thinking_level_change ?? 0) !== 0;
		let messageRole: string | null = null;
		let responseModel: string | null = null;
		let toolCallCount = 0;
		let usage: IndexedUsage | undefined;
		if (entry.type === "model_change") {
			effectiveProvider = entry.provider;
			effectiveModelId = entry.modelId;
		} else if (entry.type === "thinking_level_change") {
			effectiveThinkingLevel = entry.thinkingLevel;
			hasThinkingLevelChange = true;
		} else if (entry.type === "message") {
			messageRole = entry.message.role;
			if (entry.message.role === "assistant") {
				effectiveProvider = typeof entry.message.provider === "string" ? entry.message.provider : effectiveProvider;
				effectiveModelId = typeof entry.message.model === "string" ? entry.message.model : effectiveModelId;
				responseModel =
					typeof entry.message.responseModel === "string"
						? entry.message.responseModel
						: typeof entry.message.model === "string"
							? entry.message.model
							: null;
				toolCallCount = Array.isArray(entry.message.content)
					? entry.message.content.filter((content) => isRecord(content) && content.type === "toolCall").length
					: 0;
				usage = indexedUsage(entry.message.usage);
			} else if (entry.message.role === "toolResult") {
				usage = indexedUsage(entry.message.usage);
			}
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") usage = indexedUsage(entry.usage);
		const customType = entry.type === "custom" || entry.type === "custom_message" ? entry.customType : null;
		const firstKeptId = entry.type === "compaction" ? entry.firstKeptEntryId : null;
		const nearestCompactionId = entry.type === "compaction" ? entry.id : (parent?.nearest_compaction_id ?? null);
		const ancestryCount = (parent?.ancestry_count ?? 0) + 1;
		const ancestryPayloadBytes = (parent?.ancestry_payload_bytes ?? 0) + length;
		let contextCount = (parent?.context_count ?? 0) + 1;
		let contextPayloadBytes = (parent?.context_payload_bytes ?? 0) + length;
		if (entry.type === "compaction") {
			contextCount = 1;
			contextPayloadBytes = length;
			let current = parent;
			let retainedCount = 0;
			let retainedBytes = 0;
			let steps = 0;
			while (current && steps++ <= (parent?.ancestry_count ?? 0)) {
				retainedCount++;
				retainedBytes += current.length;
				if (current.id === entry.firstKeptEntryId) {
					contextCount += retainedCount;
					contextPayloadBytes += retainedBytes;
					break;
				}
				current = current.parent_id ? (statements.byId.get(current.parent_id) as EntryRow | undefined) : undefined;
			}
		}
		const labelTargetId = entry.type === "label" ? entry.targetId : null;
		const labelValue = entry.type === "label" ? (entry.label ?? null) : null;
		const sessionName = entry.type === "session_info" ? (entry.name ?? null) : null;
		const timestampMs = new Date(entry.timestamp).getTime();
		const treePreviewJson = JSON.stringify(createTreePreviewEntry(entry));

		statements.insert.run(
			ordinal,
			entry.type === "message" ? messageOrdinal : null,
			entry.id,
			entry.parentId,
			entry.type,
			customType,
			entry.timestamp,
			Number.isNaN(timestampMs) ? null : timestampMs,
			offset,
			length,
			ancestryCount,
			ancestryPayloadBytes,
			contextCount,
			contextPayloadBytes,
			firstKeptId,
			nearestCompactionId,
			labelTargetId,
			labelValue,
			sessionName,
			messageRole,
			responseModel,
			toolCallCount,
			usage?.input ?? 0,
			usage?.output ?? 0,
			usage?.cacheRead ?? 0,
			usage?.cacheWrite ?? 0,
			usage?.cost ?? 0,
			effectiveProvider,
			effectiveModelId,
			effectiveThinkingLevel,
			hasThinkingLevelChange ? 1 : 0,
			treePreviewJson,
		);

		if (entry.type === "label") {
			if (entry.label) {
				statements.upsertLabel.run(entry.targetId, entry.label, entry.id, entry.timestamp, ordinal);
			} else {
				statements.deleteLabel.run(entry.targetId);
			}
		}

		return statements.byOrdinal.get(ordinal) as unknown as EntryRow;
	}

	private sourceState(): SourceStateRow {
		return this.sourceStateStatement.get() as unknown as SourceStateRow;
	}

	private rebindSourceDescriptorIfNeeded(): void {
		if (this.sourceFd === undefined) throw new Error("Session history store is closed");
		const state = this.sourceState();
		const current = sourceDescriptorState(this.sourceFd);
		if (current.size >= state.indexed_length && generationMatches(state, current)) return;

		const replacement = openVerifiedIndexedDescriptor(state, this.filePath);
		try {
			this.db
				.prepare(`
				UPDATE source_state
				SET source_dev = ?, source_ino = ?, source_mtime_ns = ?, source_ctime_ns = ?
				WHERE singleton = 1
			`)
				.run(
					replacement.generation.dev,
					replacement.generation.ino,
					replacement.generation.mtimeNs,
					replacement.generation.ctimeNs,
				);
		} catch (error) {
			closeSync(replacement.fd);
			throw error;
		}
		const previous = this.sourceFd;
		this.sourceFd = replacement.fd;
		closeSync(previous);
	}

	get leafId(): string | null {
		return this.volatileLeafId;
	}

	has(id: string): boolean {
		return this.getEntryMetadata(id) !== undefined;
	}

	setVolatileLeaf(id: string | null): void {
		if (id !== null && !this.has(id)) throw new Error(`Entry ${id} not found`);
		this.volatileLeafId = id;
		this.refreshActiveProjection();
	}

	getEntryMetadata(id: string): EntryMetadata | undefined {
		const row = this.entryStatements.byId.get(id) as EntryRow | undefined;
		return row ? toMetadata(row) : undefined;
	}

	private getRowByOrdinal(ordinal: number): EntryRow | undefined {
		return this.entryStatements.byOrdinal.get(ordinal) as EntryRow | undefined;
	}

	private hydrate(metadata: EntryMetadata, cache = true): SessionEntry {
		const active = this.activeByOrdinal.get(metadata.ordinal);
		if (active) return active;
		const cached = this.cache.get(metadata.ordinal);
		if (cached) return cached;
		const bytes = Buffer.allocUnsafe(metadata.length);
		if (!readExactSync(this.sourceFd!, bytes, metadata.offset)) {
			throw new Error(`Unable to hydrate session entry ${metadata.id}`);
		}
		const parsed = parseFileEntry(bytes);
		if (!parsed || !isSessionEntry(parsed) || !entryMatchesMetadata(parsed, metadata)) {
			throw new Error(`Session index mismatch for entry ${metadata.id}`);
		}
		if (cache) this.cache.set(metadata.ordinal, parsed, metadata.length);
		return parsed;
	}

	getEntry(id: string): SessionEntry | undefined {
		if (this.activeVisitorMetadata?.id === id) {
			this.activeVisitorEntry ??= this.hydrate(this.activeVisitorMetadata, false);
			return this.activeVisitorEntry;
		}
		const metadata = this.getEntryMetadata(id);
		return metadata ? this.hydrate(metadata) : undefined;
	}

	getMessageByOrdinal(messageOrdinal: number): SessionEntry | undefined {
		if (!Number.isSafeInteger(messageOrdinal) || messageOrdinal < 0) return undefined;
		const row = this.messageByOrdinalStatement.get(messageOrdinal) as EntryRow | undefined;
		return row ? this.hydrate(toMetadata(row)) : undefined;
	}

	getChildren(parentId: string): SessionEntry[] {
		const rows = this.db
			.prepare("SELECT * FROM entries WHERE parent_id = ? ORDER BY timestamp_ms, ordinal")
			.all(parentId) as unknown as EntryRow[];
		return rows.map((row) => this.hydrate(toMetadata(row)));
	}

	getLabel(id: string): string | undefined {
		const row = this.labelByTargetStatement.get(id) as { label: string } | undefined;
		return row?.label;
	}

	getLabelTimestamp(id: string): string | undefined {
		const row = this.labelByTargetStatement.get(id) as { label_timestamp: string } | undefined;
		return row?.label_timestamp;
	}

	getSessionName(): string | undefined {
		return this.sourceState().current_name?.trim() || undefined;
	}

	getLatestCustomEntry(customType: string, scope: "all" | "active" = "all"): SessionEntry | undefined {
		if (scope === "active") {
			const maximumSteps = this.getHistorySummary().entryCount + 1;
			let steps = 0;
			let currentId = this.volatileLeafId;
			while (currentId && steps++ < maximumSteps) {
				const metadata = this.getEntryMetadata(currentId);
				if (!metadata) break;
				if (metadata.customType === customType) return this.hydrate(metadata);
				currentId = metadata.parentId;
			}
			if (currentId) throw new Error(`Cycle in session ancestry at ${currentId}`);
			return undefined;
		}
		const row = this.db
			.prepare("SELECT * FROM entries WHERE custom_type = ? ORDER BY ordinal DESC LIMIT 1")
			.get(customType) as EntryRow | undefined;
		return row ? this.hydrate(toMetadata(row)) : undefined;
	}

	getLatestMessage(role?: string, scope: "all" | "active" = "all"): SessionEntry | undefined {
		if (scope === "active") {
			const maximumSteps = this.getHistorySummary().entryCount + 1;
			let steps = 0;
			let currentId = this.volatileLeafId;
			while (currentId && steps++ < maximumSteps) {
				const metadata = this.getEntryMetadata(currentId);
				if (!metadata) break;
				if (metadata.type === "message" && (!role || metadata.messageRole === role)) return this.hydrate(metadata);
				currentId = metadata.parentId;
			}
			if (currentId) throw new Error(`Cycle in session ancestry at ${currentId}`);
			return undefined;
		}
		const row = role
			? (this.db.prepare("SELECT * FROM entries WHERE message_role = ? ORDER BY ordinal DESC LIMIT 1").get(role) as
					| EntryRow
					| undefined)
			: (this.db.prepare("SELECT * FROM entries WHERE type = 'message' ORDER BY ordinal DESC LIMIT 1").get() as
					| EntryRow
					| undefined);
		return row ? this.hydrate(toMetadata(row)) : undefined;
	}

	getActiveCompaction(): SessionEntry | undefined {
		if (!this.volatileLeafId) return undefined;
		const leaf = this.db
			.prepare("SELECT nearest_compaction_id FROM entries WHERE id = ? ORDER BY ordinal DESC LIMIT 1")
			.get(this.volatileLeafId) as { nearest_compaction_id: string | null } | undefined;
		return leaf?.nearest_compaction_id ? this.getEntry(leaf.nearest_compaction_id) : undefined;
	}

	getRecentActiveEntries(options: RecentActiveEntriesOptions = {}): SessionEntry[] {
		const limit = Math.max(1, Math.min(options.limit ?? 256, 4096));
		const result: SessionEntry[] = [];
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		let steps = 0;
		let currentId = this.volatileLeafId;
		while (currentId && steps++ < maximumSteps) {
			if (currentId === options.stopBeforeId) break;
			const metadata = this.getEntryMetadata(currentId);
			if (!metadata) break;
			currentId = metadata.parentId;
			if (options.type && metadata.type !== options.type) continue;
			if (options.customType && metadata.customType !== options.customType) continue;
			if (options.messageRole && metadata.messageRole !== options.messageRole) continue;
			result.push(this.hydrate(metadata));
			if (result.length >= limit) break;
		}
		if (currentId && steps >= maximumSteps) throw new Error(`Cycle in session ancestry at ${currentId}`);
		return result.reverse();
	}

	findRecentActiveEntry(
		options: Omit<RecentActiveEntriesOptions, "limit">,
		predicate: (entry: SessionEntry) => boolean,
	): SessionEntry | undefined {
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		let steps = 0;
		let currentId = this.volatileLeafId;
		while (currentId && steps++ < maximumSteps) {
			if (currentId === options.stopBeforeId) break;
			const metadata = this.getEntryMetadata(currentId);
			if (!metadata) break;
			currentId = metadata.parentId;
			if (options.type && metadata.type !== options.type) continue;
			if (options.customType && metadata.customType !== options.customType) continue;
			if (options.messageRole && metadata.messageRole !== options.messageRole) continue;
			const entry = this.hydrate(metadata);
			if (predicate(entry)) return entry;
		}
		if (currentId && steps >= maximumSteps) throw new Error(`Cycle in session ancestry at ${currentId}`);
		return undefined;
	}

	getActiveContextEntries(): SessionEntry[] {
		const entries: SessionEntry[] = [];
		this.iterateActiveContextMetadata(this.volatileLeafId, (metadata) => entries.push(this.hydrate(metadata)));
		return entries;
	}

	getActiveContextMessages(project: (entry: SessionEntry) => AgentMessage[]): AgentMessage[] {
		const messages: AgentMessage[] = [];
		this.iterateActiveContextMetadata(this.volatileLeafId, (metadata) => {
			messages.push(...project(this.hydrate(metadata)));
		});
		return messages;
	}

	/** Capture the current context as a bounded deferred source for Agent internals. */
	getActiveContextMessageSource(project: (entry: SessionEntry) => AgentMessage[]): AgentMessageSource {
		const leafId = this.volatileLeafId;
		const length = this.countActiveContextMessages(leafId, project);
		return {
			length,
			materialize: () => {
				const messages: AgentMessage[] = [];
				this.iterateActiveContextMetadata(leafId, (metadata) => {
					messages.push(...project(this.hydrate(metadata)));
				});
				return messages;
			},
			last: (role) => this.findLastActiveContextMessage(leafId, project, role),
			iterateReverse: () => this.iterateActiveContextMessagesReverse(leafId, project),
		};
	}

	private *iterateActiveContextMessagesReverse(
		leafId: string | null,
		project: (entry: SessionEntry) => AgentMessage[],
	): IterableIterator<AgentMessage> {
		for (const metadata of this.iterateActiveContextMetadataReverse(leafId)) {
			if (!metadataProjectsRole(metadata)) continue;
			const messages = project(this.hydrate(metadata));
			for (let index = messages.length - 1; index >= 0; index--) yield messages[index]!;
		}
	}

	private countActiveContextMessages(leafId: string | null, project: (entry: SessionEntry) => AgentMessage[]): number {
		if (!leafId) return 0;
		const leaf = this.getRowByOrdinal(this.getEntryMetadata(leafId)?.ordinal ?? -1);
		if (leaf && leaf.nearest_compaction_id === null && leaf.ancestry_count === leaf.ordinal + 1) {
			const base = this.db
				.prepare(`
					SELECT COUNT(*) AS count
					FROM entries
					WHERE ordinal <= ? AND type IN ('message', 'custom_message', 'compaction')
				`)
				.get(leaf.ordinal) as { count: number };
			let count = base.count;
			const branchSummaries = this.db.prepare(
				"SELECT * FROM entries WHERE ordinal <= ? AND type = 'branch_summary' ORDER BY ordinal",
			);
			for (const value of branchSummaries.iterate(leaf.ordinal)) {
				count += project(this.hydrate(toMetadata(value as unknown as EntryRow))).length;
			}
			return count;
		}

		let count = 0;
		this.iterateActiveContextMetadata(leafId, (metadata) => {
			if (metadata.type === "message" || metadata.type === "custom_message" || metadata.type === "compaction") {
				count++;
			} else if (metadata.type === "branch_summary") {
				count += project(this.hydrate(metadata)).length;
			}
		});
		return count;
	}

	getActiveBranchMetadata(): EntryMetadata[] {
		return this.getBranchMetadata(this.volatileLeafId);
	}

	getBranch(fromId?: string): SessionEntry[] {
		return this.getBranchMetadata(fromId ?? this.volatileLeafId).map((metadata) => this.hydrate(metadata));
	}

	iterateBranchEntries(fromId: string, visitor: (entry: SessionEntry, metadata: EntryMetadata) => void): void {
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		const ancestry = this.db.prepare(`
			WITH RECURSIVE path(ordinal, parent_id, depth) AS (
				SELECT ordinal, parent_id, 0
				FROM entries
				WHERE ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ?)
				UNION ALL
				SELECT parent.ordinal, parent.parent_id, path.depth + 1
				FROM path
				JOIN entries AS parent
					ON parent.ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = path.parent_id)
				WHERE path.depth + 1 < ?
			)
			SELECT entries.*, path.depth AS traversal_depth
			FROM path
			JOIN entries USING (ordinal)
			ORDER BY traversal_depth DESC
		`);
		let visited = 0;
		for (const value of ancestry.iterate(fromId, maximumSteps)) {
			const row = value as unknown as EntryRow & { traversal_depth: number };
			const metadata = toMetadata(row);
			visitor(this.hydrate(metadata), metadata);
			visited++;
		}
		if (visited >= maximumSteps) throw new Error(`Cycle in session ancestry at ${fromId}`);
	}

	private getBranchMetadata(fromId?: string | null): EntryMetadata[] {
		const result: EntryMetadata[] = [];
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		let steps = 0;
		let currentId = fromId ?? null;
		while (currentId && steps++ < maximumSteps) {
			const metadata = this.getEntryMetadata(currentId);
			if (!metadata) break;
			result.push(metadata);
			currentId = metadata.parentId;
		}
		if (currentId && steps >= maximumSteps) throw new Error(`Cycle in session ancestry at ${currentId}`);
		result.reverse();
		return result;
	}

	private getActiveContextOrdinals(leafId = this.volatileLeafId): number[] {
		type AncestryRow = Pick<EntryRow, "ordinal" | "id" | "parent_id" | "type" | "first_kept_id"> & {
			depth: number;
		};
		if (!leafId) return [];
		const leaf = this.db.prepare("SELECT * FROM entries WHERE id = ? ORDER BY ordinal DESC LIMIT 1").get(leafId) as
			| EntryRow
			| undefined;
		if (leaf && leaf.nearest_compaction_id === null && leaf.ancestry_count === leaf.ordinal + 1) {
			return Array.from({ length: leaf.ancestry_count }, (_, ordinal) => ordinal);
		}
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		const ancestry = this.db.prepare(`
				WITH RECURSIVE ancestry(ordinal, id, parent_id, type, first_kept_id, depth) AS (
					SELECT ordinal, id, parent_id, type, first_kept_id, 0
					FROM entries
					WHERE ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ?)
					UNION ALL
					SELECT parent.ordinal, parent.id, parent.parent_id, parent.type, parent.first_kept_id, ancestry.depth + 1
					FROM ancestry
					JOIN entries AS parent
						ON parent.ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ancestry.parent_id)
					WHERE ancestry.depth + 1 < ?
				)
				SELECT ordinal, id, parent_id, type, first_kept_id, depth FROM ancestry
			`);
		let count = 0;
		let tailParentId: string | null = null;
		let compaction: AncestryRow | undefined;
		let foundFirstKept = false;
		const postCompaction: number[] = [];
		const kept: number[] = [];
		for (const value of ancestry.iterate(leafId, maximumSteps)) {
			const row = value as unknown as AncestryRow;
			count++;
			tailParentId = row.parent_id;
			if (!compaction) {
				if (row.type === "compaction") compaction = row;
				else postCompaction.push(row.ordinal);
				continue;
			}
			kept.push(row.ordinal);
			if (row.id === compaction.first_kept_id) {
				foundFirstKept = true;
				break;
			}
		}
		if (count >= maximumSteps && tailParentId) throw new Error(`Cycle in session ancestry at ${tailParentId}`);
		if (!compaction) return postCompaction.reverse();
		if (!foundFirstKept) return [compaction.ordinal, ...postCompaction.reverse()];
		return [compaction.ordinal, ...kept.reverse(), ...postCompaction.reverse()];
	}

	/** Stream a captured active context in presentation order without retaining its ordinals. */
	private iterateActiveContextMetadata(leafId: string | null, visitor: (metadata: EntryMetadata) => void): void {
		if (!leafId) return;
		const leaf = this.getEntryMetadata(leafId);
		if (!leaf) return;
		if (!leaf.nearestCompactionId && leaf.ordinal + 1 === this.getRowByOrdinal(leaf.ordinal)?.ancestry_count) {
			const rows = this.db.prepare("SELECT * FROM entries WHERE ordinal <= ? ORDER BY ordinal");
			for (const value of rows.iterate(leaf.ordinal)) visitor(toMetadata(value as unknown as EntryRow));
			return;
		}

		const maximumSteps = this.getHistorySummary().entryCount + 1;
		const rows = this.db.prepare(`
			WITH RECURSIVE ancestry(ordinal, id, parent_id, type, first_kept_id, depth) AS (
				SELECT ordinal, id, parent_id, type, first_kept_id, 0
				FROM entries
				WHERE ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ?)
				UNION ALL
				SELECT parent.ordinal, parent.id, parent.parent_id, parent.type, parent.first_kept_id,
					ancestry.depth + 1
				FROM ancestry
				JOIN entries AS parent
					ON parent.ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ancestry.parent_id)
				WHERE ancestry.depth + 1 < ?
			),
			latest_compaction AS (
				SELECT ordinal, id, first_kept_id, depth
				FROM ancestry
				WHERE type = 'compaction'
				ORDER BY depth
				LIMIT 1
			),
			first_kept AS (
				SELECT ancestry.depth
				FROM ancestry, latest_compaction
				WHERE ancestry.id = latest_compaction.first_kept_id
				  AND ancestry.depth > latest_compaction.depth
				ORDER BY ancestry.depth
				LIMIT 1
			),
			selected AS (
				SELECT ancestry.*
				FROM ancestry
				WHERE NOT EXISTS (SELECT 1 FROM latest_compaction)
				   OR ancestry.ordinal = (SELECT ordinal FROM latest_compaction)
				   OR ancestry.depth < (SELECT depth FROM latest_compaction)
				   OR (
					EXISTS (SELECT 1 FROM first_kept)
					AND ancestry.depth > (SELECT depth FROM latest_compaction)
					AND ancestry.depth <= (SELECT depth FROM first_kept)
				   )
			)
			SELECT entries.*, selected.depth AS traversal_depth,
				CASE WHEN selected.ordinal = (SELECT ordinal FROM latest_compaction) THEN 0 ELSE 1 END AS context_group
			FROM selected
			JOIN entries USING (ordinal)
			ORDER BY context_group, selected.depth DESC
		`);
		let visited = 0;
		for (const value of rows.iterate(leafId, maximumSteps)) {
			visitor(toMetadata(value as unknown as EntryRow));
			visited++;
		}
		if (visited >= maximumSteps) throw new Error(`Cycle in session ancestry at ${leafId}`);
	}

	/** Stream a captured active context newest-first without retaining its ordinals or messages. */
	private *iterateActiveContextMetadataReverse(leafId: string | null): IterableIterator<EntryMetadata> {
		if (!leafId) return;
		const leaf = this.getEntryMetadata(leafId);
		if (!leaf) return;
		if (!leaf.nearestCompactionId && leaf.ordinal + 1 === this.getRowByOrdinal(leaf.ordinal)?.ancestry_count) {
			const rows = this.db.prepare("SELECT * FROM entries WHERE ordinal <= ? ORDER BY ordinal DESC");
			for (const value of rows.iterate(leaf.ordinal)) yield toMetadata(value as unknown as EntryRow);
			return;
		}

		const maximumSteps = this.getHistorySummary().entryCount + 1;
		const rows = this.db.prepare(`
			WITH RECURSIVE ancestry(ordinal, id, parent_id, type, first_kept_id, depth) AS (
				SELECT ordinal, id, parent_id, type, first_kept_id, 0
				FROM entries
				WHERE ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ?)
				UNION ALL
				SELECT parent.ordinal, parent.id, parent.parent_id, parent.type, parent.first_kept_id,
					ancestry.depth + 1
				FROM ancestry
				JOIN entries AS parent
					ON parent.ordinal = (SELECT MAX(ordinal) FROM entries WHERE id = ancestry.parent_id)
				WHERE ancestry.depth + 1 < ?
			),
			latest_compaction AS (
				SELECT ordinal, id, first_kept_id, depth
				FROM ancestry
				WHERE type = 'compaction'
				ORDER BY depth
				LIMIT 1
			),
			first_kept AS (
				SELECT ancestry.depth
				FROM ancestry, latest_compaction
				WHERE ancestry.id = latest_compaction.first_kept_id
				  AND ancestry.depth > latest_compaction.depth
				ORDER BY ancestry.depth
				LIMIT 1
			),
			selected AS (
				SELECT ancestry.*
				FROM ancestry
				WHERE NOT EXISTS (SELECT 1 FROM latest_compaction)
				   OR ancestry.ordinal = (SELECT ordinal FROM latest_compaction)
				   OR ancestry.depth < (SELECT depth FROM latest_compaction)
				   OR (
					EXISTS (SELECT 1 FROM first_kept)
					AND ancestry.depth > (SELECT depth FROM latest_compaction)
					AND ancestry.depth <= (SELECT depth FROM first_kept)
				   )
			)
			SELECT entries.*, selected.depth AS traversal_depth,
				CASE WHEN selected.ordinal = (SELECT ordinal FROM latest_compaction) THEN 0 ELSE 1 END AS context_group
			FROM selected
			JOIN entries USING (ordinal)
			ORDER BY context_group DESC, selected.depth ASC
		`);
		let visited = 0;
		for (const value of rows.iterate(leafId, maximumSteps)) {
			yield toMetadata(value as unknown as EntryRow);
			visited++;
		}
		if (visited >= maximumSteps) throw new Error(`Cycle in session ancestry at ${leafId}`);
	}

	private findLastActiveContextMessage(
		leafId: string | null,
		project: (entry: SessionEntry) => AgentMessage[],
		role?: AgentMessage["role"],
	): AgentMessage | undefined {
		if (!leafId) return undefined;
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		let steps = 0;
		let metadata = this.getEntryMetadata(leafId);
		let compaction: EntryMetadata | undefined;
		while (metadata && steps++ < maximumSteps) {
			if (metadata.type === "compaction") {
				compaction = metadata;
				break;
			}
			if (metadataProjectsRole(metadata, role)) {
				const projected = project(this.hydrate(metadata));
				const last = lastMessageForRole(projected, role);
				if (last) return last;
			}
			metadata = metadata.parentId ? this.getEntryMetadata(metadata.parentId) : undefined;
		}
		if (metadata && steps >= maximumSteps) throw new Error(`Cycle in session ancestry at ${metadata.id}`);
		if (!compaction) return undefined;

		let retainedLast: AgentMessage | undefined;
		metadata = compaction.parentId ? this.getEntryMetadata(compaction.parentId) : undefined;
		while (metadata && steps++ < maximumSteps) {
			if (!retainedLast && metadataProjectsRole(metadata, role)) {
				const projected = project(this.hydrate(metadata));
				retainedLast = lastMessageForRole(projected, role);
			}
			if (metadata.id === compaction.firstKeptEntryId) {
				if (!metadataProjectsRole(compaction, role)) return retainedLast;
				const projected = project(this.hydrate(compaction));
				return retainedLast ?? lastMessageForRole(projected, role);
			}
			metadata = metadata.parentId ? this.getEntryMetadata(metadata.parentId) : undefined;
		}
		if (metadata && steps >= maximumSteps) throw new Error(`Cycle in session ancestry at ${metadata.id}`);
		if (!metadataProjectsRole(compaction, role)) return undefined;
		const projected = project(this.hydrate(compaction));
		return lastMessageForRole(projected, role);
	}

	private getActiveContextMetadata(): EntryMetadata[] {
		return this.getActiveContextOrdinals().flatMap((ordinal) => {
			const row = this.getRowByOrdinal(ordinal);
			return row ? [toMetadata(row)] : [];
		});
	}

	private refreshActiveProjection(): void {
		const previousOrdinals = this.activeOrdinals;
		const previousLengths = this.activeLengths;
		const leaf = this.volatileLeafId
			? (this.db
					.prepare("SELECT * FROM entries WHERE id = ? ORDER BY ordinal DESC LIMIT 1")
					.get(this.volatileLeafId) as EntryRow | undefined)
			: undefined;
		this.activeEntryCount = leaf?.context_count ?? 0;
		this.activePayloadBytes = leaf?.context_payload_bytes ?? 0;
		this.activeProjectionRetained =
			this.activeEntryCount <= MAX_RETAINED_ACTIVE_ENTRIES && this.activePayloadBytes <= MAX_RETAINED_ACTIVE_BYTES;
		const activeMetadata = this.activeProjectionRetained ? this.getActiveContextMetadata() : [];
		if (this.activeProjectionRetained) {
			this.activeEntryCount = activeMetadata.length;
			this.activePayloadBytes = activeMetadata.reduce((total, metadata) => total + metadata.length, 0);
		}

		const nextOrdinals = new Set(activeMetadata.map((entry) => entry.ordinal));
		const nextEntries = activeMetadata.map((entry) => this.hydrate(entry, false));
		this.activeOrdinals = nextOrdinals;
		this.activeByOrdinal = new Map(activeMetadata.map((metadata, index) => [metadata.ordinal, nextEntries[index]]));
		this.activeLengths = new Map(activeMetadata.map((metadata) => [metadata.ordinal, metadata.length]));

		for (const ordinal of previousOrdinals) {
			if (nextOrdinals.has(ordinal)) continue;
			this.evictedEntries++;
			this.evictedBytes += previousLengths.get(ordinal) ?? 0;
		}
		const eviction = this.cache.evict((ordinal) => !nextOrdinals.has(ordinal));
		this.evictedEntries += eviction.entries;
		this.evictedBytes += eviction.bytes;
	}

	getEffectiveContextSettings(): {
		thinkingLevel: string;
		model: { provider: string; modelId: string } | null;
		hasThinkingLevelChange: boolean;
	} {
		const leaf = this.volatileLeafId ? this.getEntryMetadata(this.volatileLeafId) : undefined;
		return {
			thinkingLevel: leaf?.effectiveThinkingLevel ?? "off",
			hasThinkingLevelChange: leaf?.hasThinkingLevelChange ?? false,
			model:
				leaf?.effectiveProvider && leaf.effectiveModelId
					? { provider: leaf.effectiveProvider, modelId: leaf.effectiveModelId }
					: null,
		};
	}

	hasThinkingLevelChange(): boolean {
		return this.getEffectiveContextSettings().hasThinkingLevelChange;
	}

	getEntries(): SessionEntry[] {
		const rows = this.db.prepare("SELECT * FROM entries ORDER BY ordinal").all() as unknown as EntryRow[];
		return rows.map((row) => this.hydrate(toMetadata(row)));
	}

	getEntriesPage(options: EntryPageOptions = {}): SessionEntryPage {
		const pageOptions = normalizeCursorPageOptions({
			afterOrdinal: options.afterOrdinal,
			direction: "forward",
			limit: options.limit,
		});
		const clauses = ["ordinal > ?"];
		const params: Array<string | number> = [pageOptions.afterOrdinal ?? -1];
		if (options.type) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		if (options.customType) {
			clauses.push("custom_type = ?");
			params.push(options.customType);
		}
		if (options.messageRole) {
			clauses.push("message_role = ?");
			params.push(options.messageRole);
		}
		if (options.fromOrdinal !== undefined) {
			clauses.push("ordinal >= ?");
			params.push(options.fromOrdinal);
		}
		if (options.toOrdinal !== undefined) {
			clauses.push("ordinal <= ?");
			params.push(options.toOrdinal);
		}
		const rows = this.db
			.prepare(`SELECT * FROM entries WHERE ${clauses.join(" AND ")} ORDER BY ordinal ASC LIMIT ?`)
			.all(...params, pageOptions.limit + 1) as unknown as EntryRow[];
		const hasMore = rows.length > pageOptions.limit;
		if (hasMore) rows.pop();
		return {
			entries: rows.map((row) => this.hydrate(toMetadata(row))),
			nextOrdinal: hasMore ? rows[rows.length - 1]?.ordinal : undefined,
		};
	}

	/** Read tree metadata directly from SQLite without hydrating JSONL entries. */
	getTreePage(options: SessionTreePageOptions = {}): SessionTreePage {
		const pageOptions = normalizeCursorPageOptions(options);
		if (
			(pageOptions.direction === "forward" && pageOptions.afterOrdinal === Number.MAX_SAFE_INTEGER) ||
			(pageOptions.direction === "reverse" && pageOptions.beforeOrdinal === 0)
		) {
			return { entries: [], nextOrdinal: null };
		}

		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (pageOptions.direction === "forward" && pageOptions.afterOrdinal !== undefined) {
			clauses.push("entries.ordinal > ?");
			params.push(pageOptions.afterOrdinal);
		}
		if (pageOptions.direction === "reverse" && pageOptions.beforeOrdinal !== undefined) {
			clauses.push("entries.ordinal < ?");
			params.push(pageOptions.beforeOrdinal);
		}
		if (options.type) {
			clauses.push("entries.type = ?");
			params.push(options.type);
		}
		if (options.customType) {
			clauses.push("entries.custom_type = ?");
			params.push(options.customType);
		}
		if (options.messageRole) {
			clauses.push("entries.message_role = ?");
			params.push(options.messageRole);
		}

		type TreePageRow = Pick<
			EntryRow,
			| "ordinal"
			| "message_ordinal"
			| "id"
			| "parent_id"
			| "type"
			| "custom_type"
			| "message_role"
			| "timestamp"
			| "tree_preview_json"
		> & {
			tree_label: string | null;
			tree_label_timestamp: string | null;
		};
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const direction = pageOptions.direction === "reverse" ? "DESC" : "ASC";
		const rows = this.db
			.prepare(`
				SELECT entries.ordinal, entries.message_ordinal, entries.id, entries.parent_id,
					entries.type, entries.custom_type, entries.message_role, entries.timestamp,
					entries.tree_preview_json,
					current_labels.label AS tree_label,
					current_labels.label_timestamp AS tree_label_timestamp
				FROM entries
				LEFT JOIN current_labels ON current_labels.target_id = entries.id
				${where}
				ORDER BY entries.ordinal ${direction}
				LIMIT ?
			`)
			.all(...params, pageOptions.limit + 1) as unknown as TreePageRow[];
		const hasMore = rows.length > pageOptions.limit;
		if (hasMore) rows.pop();
		const nextOrdinal = hasMore ? rows[rows.length - 1]!.ordinal : null;
		if (pageOptions.direction === "reverse") rows.reverse();
		return {
			entries: rows.map((row): SessionTreePageEntry => {
				const preview = parseFileEntry(Buffer.from(row.tree_preview_json));
				if (!preview || !isSessionEntry(preview)) {
					throw new Error(`Invalid tree preview for session entry ${row.id}`);
				}
				return {
					ordinal: row.ordinal,
					messageOrdinal: row.message_ordinal ?? undefined,
					id: row.id,
					parentId: row.parent_id,
					type: row.type as SessionTreePageEntry["type"],
					customType: row.custom_type ?? undefined,
					messageRole: row.message_role ?? undefined,
					timestamp: row.timestamp,
					label: row.tree_label ?? undefined,
					labelTimestamp: row.tree_label_timestamp ?? undefined,
					entryPreview: preview,
				};
			}),
			nextOrdinal,
		};
	}

	getTree(): SessionTreeNode[] {
		type TreeRow = EntryRow & {
			tree_label: string | null;
			tree_label_timestamp: string | null;
		};
		const records: Array<{ row: TreeRow; node: SessionTreeNode }> = [];
		const latestById = new Map<string, { row: TreeRow; node: SessionTreeNode }>();
		const ordinalByNode = new Map<SessionTreeNode, number>();
		const roots: SessionTreeNode[] = [];
		const rows = this.db.prepare(`
			SELECT entries.*,
				current_labels.label AS tree_label,
				current_labels.label_timestamp AS tree_label_timestamp
			FROM entries
			LEFT JOIN current_labels ON current_labels.target_id = entries.id
			ORDER BY entries.ordinal
		`);
		for (const value of rows.iterate()) {
			const row = value as unknown as TreeRow;
			const node: SessionTreeNode = {
				entry: this.hydrate(toMetadata(row), false),
				children: [],
				label: row.tree_label ?? undefined,
				labelTimestamp: row.tree_label_timestamp ?? undefined,
			};
			const record = { row, node };
			records.push(record);
			latestById.set(row.id, record);
			ordinalByNode.set(node, row.ordinal);
		}
		for (const record of records) {
			const parent = record.row.parent_id ? latestById.get(record.row.parent_id)?.node : undefined;
			if (!parent || record.row.parent_id === record.row.id) roots.push(record.node);
			else parent.children.push(record.node);
		}
		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((left, right) => {
				const timestampOrder = new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime();
				return timestampOrder || ordinalByNode.get(left)! - ordinalByNode.get(right)!;
			});
			stack.push(...node.children);
		}
		return roots;
	}

	async iterateEntries(
		options: IterateEntriesOptions,
		visitor: (entry: SessionEntry, metadata: EntryMetadata) => void | Promise<void>,
	): Promise<void> {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (options.type) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		if (options.customType) {
			clauses.push("custom_type = ?");
			params.push(options.customType);
		}
		if (options.messageRole) {
			clauses.push("message_role = ?");
			params.push(options.messageRole);
		}
		if (options.fromOrdinal !== undefined) {
			clauses.push("ordinal >= ?");
			params.push(options.fromOrdinal);
		}
		if (options.toOrdinal !== undefined) {
			clauses.push("ordinal <= ?");
			params.push(options.toOrdinal);
		}
		const direction = options.direction === "reverse" ? "DESC" : "ASC";
		const batchSize = Math.max(1, Math.min(options.limit ?? 256, 4096));
		const totalLimit = options.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, options.limit);
		let visited = 0;
		let cursor = options.direction === "reverse" ? Number.MAX_SAFE_INTEGER : -1;
		while (visited < totalLimit) {
			const cursorClause = options.direction === "reverse" ? "ordinal < ?" : "ordinal > ?";
			const where = [...clauses, cursorClause].join(" AND ");
			const rows = this.db
				.prepare(`SELECT * FROM entries WHERE ${where} ORDER BY ordinal ${direction} LIMIT ?`)
				.all(...params, cursor, Math.min(batchSize, totalLimit - visited)) as unknown as EntryRow[];
			if (rows.length === 0) break;
			for (const row of rows) {
				const metadata = toMetadata(row);
				await visitor(this.hydrate(metadata), metadata);
				visited++;
			}
			cursor = rows[rows.length - 1].ordinal;
		}
	}

	async iterateActiveAncestry(visitor: (metadata: EntryMetadata) => void | Promise<void>): Promise<void> {
		const maximumSteps = this.getHistorySummary().entryCount + 1;
		let visited = 0;
		let currentId = this.volatileLeafId;
		// This iterator is intentionally newest-first: recent-history and latest-compaction
		// consumers can stop without walking or retaining the complete branch. Resolve one
		// parent before awaiting user code so no SQLite cursor/read transaction crosses await.
		while (currentId && visited < maximumSteps) {
			const metadata = this.getEntryMetadata(currentId);
			if (!metadata) break;
			currentId = metadata.parentId;
			this.activeVisitorMetadata = metadata;
			try {
				await visitor(metadata);
			} finally {
				this.activeVisitorEntry = undefined;
				this.activeVisitorMetadata = undefined;
			}
			visited++;
		}
		if (currentId && visited >= maximumSteps) throw new Error(`Cycle in session ancestry at ${currentId}`);
	}

	append(entry: SessionEntry): void {
		const serialized = JSON.stringify(entry);
		if (serialized === undefined) throw new Error("Session entry is not serializable");
		const bytes = Buffer.from(serialized, "utf8");
		if (bytes.length > MAX_SESSION_RECORD_BYTES) {
			throw new Error(`Session record exceeds ${MAX_SESSION_RECORD_BYTES} bytes`);
		}
		const persisted = parseFileEntry(bytes);
		if (
			!persisted ||
			!isSessionEntry(persisted) ||
			persisted.id !== entry.id ||
			persisted.parentId !== entry.parentId ||
			persisted.type !== entry.type ||
			persisted.timestamp !== entry.timestamp ||
			(persisted.type === "message" && entry.type === "message" && persisted.message.role !== entry.message.role)
		) {
			throw new Error("Serialized session entry identity does not match the appended entry");
		}
		const entryDigest = digest(bytes);
		const release = acquireSourceLock(this.filePath);
		let sourceMayHaveChanged = false;
		try {
			IndexedJsonlSessionHistoryStore.catchUp(this.db, this.filePath);
			this.rebindSourceDescriptorIfNeeded();
			let state = this.sourceState();
			const previous =
				state.entry_count > 0
					? (this.entryStatements.byOrdinal.get(state.entry_count - 1) as EntryRow | undefined)
					: undefined;
			if (
				previous?.id === persisted.id &&
				previous.offset === state.last_record_offset &&
				previous.length === bytes.length &&
				state.last_record_length === bytes.length &&
				state.last_record_sha256 !== null &&
				entryDigest.equals(Buffer.from(state.last_record_sha256))
			) {
				this.volatileLeafId = persisted.id;
				this.refreshActiveProjection();
				return;
			}

			const fd = openSync(this.filePath, "a+");
			let offset = 0;
			let generation: SourceDescriptorState | undefined;
			let appendVerified = false;
			let closeFailure: { error: unknown } | undefined;
			try {
				if (!indexedDescriptorMatches(state, fd, this.filePath)) {
					throw new Error("Session JSONL changed outside the indexed writer before append");
				}
				let size = fstatSync(fd).size;
				if (size > 0) {
					const finalByte = Buffer.allocUnsafe(1);
					if (!readExactSync(fd, finalByte, size - 1)) throw new Error("Unable to read session tail");
					if (finalByte[0] !== 0x0a) {
						sourceMayHaveChanged = true;
						writeAllSync(fd, NEWLINE);
						fdatasyncSync(fd);
						size++;
						IndexedJsonlSessionHistoryStore.catchUp(this.db, this.filePath, true);
					}
				}
				offset = size;
				sourceMayHaveChanged = true;
				writeAllSync(fd, bytes);
				writeAllSync(fd, NEWLINE);
				fdatasyncSync(fd);
				const committed = Buffer.allocUnsafe(bytes.length + 1);
				if (
					!readExactSync(fd, committed, offset) ||
					!committed.subarray(0, bytes.length).equals(bytes) ||
					committed[bytes.length] !== 0x0a
				)
					throw new Error("Session JSONL append read-back did not match the committed entry");
				generation = sourceDescriptorState(fd);
				if (!sameDescriptorState(generation, sourcePathState(this.filePath))) {
					throw new SourceChangedDuringCatchUpError("Session JSONL was replaced during append");
				}
				appendVerified = true;
			} finally {
				try {
					closeSync(fd);
				} catch (error) {
					closeFailure = { error };
				}
			}
			if (!appendVerified && closeFailure) throw closeFailure.error;

			if (!generation) throw new Error("Session append completed without a source generation");
			state = this.sourceState();
			this.db.exec("BEGIN IMMEDIATE");
			try {
				const row = IndexedJsonlSessionHistoryStore.insertEntry(
					this.entryStatements,
					persisted,
					state.entry_count,
					state.message_count,
					offset,
					bytes.length,
				);
				const aggregate = aggregateFromSourceState(state);
				addRowToAggregate(aggregate, row);
				this.db
					.prepare(`
					UPDATE source_state SET
						source_dev = ?, source_ino = ?, source_mtime_ns = ?, source_ctime_ns = ?,
						indexed_length = ?, entry_count = ?, message_count = ?, user_message_count = ?,
						assistant_message_count = ?, tool_result_count = ?, tool_call_count = ?,
						compaction_count = ?, usage_input = ?, usage_output = ?, usage_cache_read = ?,
						usage_cache_write = ?, usage_cost = ?, latest_cache_hit_rate = ?,
						current_leaf_id = ?, active_compaction_id = ?,
						current_name = CASE WHEN ? = 'session_info' THEN ? ELSE current_name END,
						last_record_offset = ?, last_record_length = ?, last_record_sha256 = ?,
						prefix_chain_sha256 = ?, final_line_terminated = 1
					WHERE singleton = 1
					`)
					.run(
						generation.dev,
						generation.ino,
						generation.mtimeNs,
						generation.ctimeNs,
						offset + bytes.length + 1,
						state.entry_count + 1,
						aggregate.messageCount,
						aggregate.userMessages,
						aggregate.assistantMessages,
						aggregate.toolResults,
						aggregate.toolCalls,
						aggregate.compactionCount,
						aggregate.usageInput,
						aggregate.usageOutput,
						aggregate.usageCacheRead,
						aggregate.usageCacheWrite,
						aggregate.usageCost,
						aggregate.latestCacheHitRate,
						persisted.id,
						row.nearest_compaction_id,
						persisted.type,
						row.session_name,
						offset,
						bytes.length,
						entryDigest,
						extendPrefixChain(state.prefix_chain_sha256, bytes, true),
					);
				this.db.exec("COMMIT");
			} catch (error) {
				try {
					this.db.exec("ROLLBACK");
				} catch {}
				throw error;
			}
			this.rebindSourceDescriptorIfNeeded();
			this.volatileLeafId = persisted.id;
			this.refreshActiveProjection();
		} catch (error) {
			if (sourceMayHaveChanged) {
				try {
					IndexedJsonlSessionHistoryStore.catchUp(
						this.db,
						this.filePath,
						!(error instanceof SourceChangedDuringCatchUpError),
					);
					this.rebindSourceDescriptorIfNeeded();
				} catch {}
			}
			throw error;
		} finally {
			release();
		}
	}

	getHistorySummary(): SessionHistorySummary {
		const state = this.sourceState();
		return {
			entryCount: state.entry_count,
			compactionCount: state.compaction_count,
			userMessages: state.user_message_count,
			assistantMessages: state.assistant_message_count,
			toolResults: state.tool_result_count,
			totalMessages: state.message_count,
			toolCalls: state.tool_call_count,
			usage: {
				input: state.usage_input,
				output: state.usage_output,
				cacheRead: state.usage_cache_read,
				cacheWrite: state.usage_cache_write,
				cost: state.usage_cost,
			},
			latestCacheHitRate: state.latest_cache_hit_rate ?? undefined,
		};
	}

	flush(): void {
		const release = acquireSourceLock(this.filePath);
		try {
			IndexedJsonlSessionHistoryStore.catchUp(this.db, this.filePath);
			this.rebindSourceDescriptorIfNeeded();
			this.volatileLeafId = this.sourceState().current_leaf_id;
			this.refreshActiveProjection();
		} finally {
			release();
		}
	}

	getMetrics(): SessionHistoryMetrics {
		const state = this.sourceState();
		const memory = process.memoryUsage();
		return {
			process_heap_used_bytes: memory.heapUsed,
			process_external_bytes: memory.external,
			process_rss_bytes: memory.rss,
			session_history_bytes: statSync(this.filePath).size,
			session_index_entries: state.entry_count,
			session_active_entries: this.activeEntryCount,
			session_active_payload_bytes: this.activePayloadBytes,
			session_hydration_cache_bytes: this.cache.bytes,
			session_compaction_evicted_entries: this.evictedEntries,
			session_compaction_evicted_bytes: this.evictedBytes,
		};
	}

	private digestSourcePrefix(byteLength: number): string {
		if (this.sourceFd === undefined) throw new Error("Session history store is closed");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_SIZE, Math.max(1, byteLength)));
		let position = 0;
		while (position < byteLength) {
			const chunkLength = Math.min(buffer.length, byteLength - position);
			let chunkOffset = 0;
			while (chunkOffset < chunkLength) {
				const bytesRead = readSync(
					this.sourceFd,
					buffer,
					chunkOffset,
					chunkLength - chunkOffset,
					position + chunkOffset,
				);
				if (bytesRead === 0) throw new Error("Session JSONL ended while capturing an export snapshot");
				chunkOffset += bytesRead;
			}
			hash.update(buffer.subarray(0, chunkLength));
			position += chunkLength;
		}
		return hash.digest("hex");
	}

	/** Capture the complete indexed source prefix without retaining it in memory. */
	captureSourceSnapshot(toOrdinal: number): SessionSourceSnapshot {
		if (this.sourceFd === undefined) throw new Error("Session history store is closed");
		const state = this.sourceState();
		if (!Number.isSafeInteger(toOrdinal) || toOrdinal !== state.entry_count - 1) {
			throw new Error("Session history changed while capturing the export boundary");
		}
		const before = sourceDescriptorState(this.sourceFd);
		if (
			state.source_dev === null ||
			state.source_ino === null ||
			state.source_dev !== before.dev ||
			state.source_ino !== before.ino ||
			state.source_mtime_ns !== before.mtimeNs ||
			state.source_ctime_ns !== before.ctimeNs ||
			state.indexed_length !== before.size
		) {
			throw new Error("Session JSONL changed outside the indexed writer; close and reopen it before exporting");
		}
		const sha256 = this.digestSourcePrefix(state.indexed_length);
		const after = sourceDescriptorState(this.sourceFd);
		if (!sameDescriptorState(before, after)) {
			throw new Error("Session JSONL changed while capturing the export boundary");
		}
		return {
			dev: before.dev,
			ino: before.ino,
			byteLength: state.indexed_length,
			mtimeNs: before.mtimeNs,
			ctimeNs: before.ctimeNs,
			sha256,
		};
	}

	/** Verify that a captured source prefix is unchanged, while allowing later appends. */
	assertSourceSnapshot(snapshot: SessionSourceSnapshot): void {
		if (this.sourceFd === undefined) throw new Error("Session history store is closed");
		const before = sourceDescriptorState(this.sourceFd);
		if (before.dev !== snapshot.dev || before.ino !== snapshot.ino || before.size < snapshot.byteLength) {
			throw new Error("Session JSONL changed while exporting");
		}
		if (
			before.size === snapshot.byteLength &&
			(before.mtimeNs !== snapshot.mtimeNs || before.ctimeNs !== snapshot.ctimeNs)
		) {
			throw new Error("Session JSONL changed while exporting");
		}
		const sha256 = this.digestSourcePrefix(snapshot.byteLength);
		const after = sourceDescriptorState(this.sourceFd);
		if (!sameDescriptorState(before, after) || sha256 !== snapshot.sha256) {
			throw new Error("Session JSONL changed while exporting");
		}
	}

	/** Identity of the source file descriptor this store actually reads. */
	getSourceIdentity(): SessionSourceIdentity {
		if (this.sourceFd === undefined) throw new Error("Session history store is closed");
		const stats = fstatSync(this.sourceFd);
		return { dev: stats.dev, ino: stats.ino };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.activeByOrdinal.clear();
		this.activeOrdinals.clear();
		this.activeLengths.clear();
		this.activeEntryCount = 0;
		this.activePayloadBytes = 0;
		this.activeVisitorMetadata = undefined;
		this.activeVisitorEntry = undefined;
		this.cache.clear();
		try {
			if (this.sourceFd !== undefined) closeSync(this.sourceFd);
		} finally {
			this.sourceFd = undefined;
			try {
				this.db.close();
			} finally {
				if (this.temporaryIndexRoot) rmSync(this.temporaryIndexRoot, { recursive: true, force: true });
			}
		}
	}
}
