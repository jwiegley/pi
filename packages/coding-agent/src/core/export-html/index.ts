import type { AgentState } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";
import { DatabaseSync, type StatementSync } from "../sqlite.ts";

/**
 * Interface for rendering custom tools to HTML.
 * Used by agent-session to pre-render extension tool output.
 */
export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to HTML. Returns collapsed/expanded or undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** Pre-rendered HTML for a custom tool call and result */
interface RenderedToolHtml {
	callHtml?: string;
	resultHtmlCollapsed?: string;
	resultHtmlExpanded?: string;
}

export interface ExportOptions {
	/** Destination for a no-clobber export; an existing path is rejected. */
	outputPath?: string;
	themeName?: string;
	/** Optional tool renderer for custom tools */
	toolRenderer?: ToolHtmlRenderer;
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: SessionEntry[];
	leafId: string | null;
	systemPrompt?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	/** Pre-rendered HTML for custom tool calls/results, keyed by tool call ID */
	renderedTools?: Record<string, RenderedToolHtml>;
}

type StreamingSessionData = Omit<SessionData, "entries" | "renderedTools"> & {
	toOrdinal: number;
	sourceSnapshot: ReturnType<SessionManager["captureSessionSourceSnapshot"]>;
	renderedTools?: RenderedToolsSpool;
};

interface RenderedToolRow {
	tool_call_id: string;
	call_html: string | null;
	result_html_collapsed: string | null;
	result_html_expanded: string | null;
}

function renderedToolRow(value: Record<string, unknown>): RenderedToolRow {
	const { tool_call_id, call_html, result_html_collapsed, result_html_expanded } = value;
	if (
		typeof tool_call_id !== "string" ||
		(call_html !== null && typeof call_html !== "string") ||
		(result_html_collapsed !== null && typeof result_html_collapsed !== "string") ||
		(result_html_expanded !== null && typeof result_html_expanded !== "string")
	) {
		throw new Error("The rendered tool spool returned an invalid row");
	}
	return { tool_call_id, call_html, result_html_collapsed, result_html_expanded };
}

function propertyArrayIndex(value: string): number | null {
	const index = Number(value);
	return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === value ? index : null;
}

class RenderedToolsSpool {
	private readonly db: DatabaseSync;
	private readonly root: string;
	private readonly containsStatement: StatementSync;
	private readonly setCallStatement: StatementSync;
	private readonly setResultStatement: StatementSync;
	private readonly emptyStatement: StatementSync;
	private readonly entriesStatement: StatementSync;
	private dbClosed = false;
	private removed = false;

	constructor() {
		const root = mkdtempSync(join(tmpdir(), `pi-export-tools-${process.pid}-`));
		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(join(root, "rendered-tools.sqlite"));
			db.exec(`
				PRAGMA cache_size = -1024;
				PRAGMA temp_store = FILE;
				CREATE TABLE rendered_tools (
					sequence INTEGER PRIMARY KEY AUTOINCREMENT,
					tool_call_id TEXT NOT NULL UNIQUE,
					array_index INTEGER,
					call_html TEXT,
					result_html_collapsed TEXT,
					result_html_expanded TEXT
				)
			`);
			this.root = root;
			this.db = db;
			this.containsStatement = db.prepare("SELECT 1 FROM rendered_tools WHERE tool_call_id = ?");
			this.setCallStatement = db.prepare(`
				INSERT INTO rendered_tools (tool_call_id, array_index, call_html)
				VALUES (?, ?, ?)
				ON CONFLICT(tool_call_id) DO UPDATE SET
					call_html = excluded.call_html,
					result_html_collapsed = NULL,
					result_html_expanded = NULL
			`);
			this.setResultStatement = db.prepare(`
				INSERT INTO rendered_tools (
					tool_call_id,
					array_index,
					result_html_collapsed,
					result_html_expanded
				)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(tool_call_id) DO UPDATE SET
					result_html_collapsed = excluded.result_html_collapsed,
					result_html_expanded = excluded.result_html_expanded
			`);
			this.emptyStatement = db.prepare("SELECT 1 FROM rendered_tools LIMIT 1");
			this.entriesStatement = db.prepare(`
				SELECT tool_call_id, call_html, result_html_collapsed, result_html_expanded
				FROM rendered_tools
				ORDER BY array_index IS NULL, array_index, sequence
			`);
		} catch (error) {
			try {
				db?.close();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
			throw error;
		}
	}

	begin(): void {
		this.db.exec("BEGIN");
	}

	commit(): void {
		this.db.exec("COMMIT");
	}

	rollback(): void {
		this.db.exec("ROLLBACK");
	}

	has(toolCallId: string): boolean {
		return this.containsStatement.get(toolCallId) !== undefined;
	}

	setCall(toolCallId: string, callHtml: string): void {
		this.setCallStatement.run(toolCallId, propertyArrayIndex(toolCallId), callHtml);
	}

	setResult(toolCallId: string, collapsed: string | undefined, expanded: string | undefined): void {
		this.setResultStatement.run(toolCallId, propertyArrayIndex(toolCallId), collapsed ?? null, expanded ?? null);
	}

	isEmpty(): boolean {
		return this.emptyStatement.get() === undefined;
	}

	*entries(): IterableIterator<RenderedToolRow> {
		for (const row of this.entriesStatement.iterate()) yield renderedToolRow(row);
	}

	close(): void {
		let firstError: unknown;
		if (!this.dbClosed) {
			try {
				this.db.close();
				this.dbClosed = true;
			} catch (error) {
				firstError = error;
			}
		}
		if (!this.removed) {
			try {
				rmSync(this.root, { recursive: true, force: true });
				this.removed = true;
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) throw firstError;
	}
}

interface HtmlParts {
	prefix: string;
	suffix: string;
}

/**
 * Core HTML generation logic shared by both export functions.
 */
function generateHtmlParts(themeName?: string): HtmlParts {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;

	// Build the CSS with theme variables injected
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	const sessionDataMarker = "\0pi-session-data\0";
	const html = template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataMarker)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
	const markerIndex = html.indexOf(sessionDataMarker);
	if (markerIndex === -1) throw new Error("HTML export template is missing {{SESSION_DATA}}");
	return {
		prefix: html.slice(0, markerIndex),
		suffix: html.slice(markerIndex + sessionDataMarker.length),
	};
}

/**
 * Core HTML generation logic retained for compatibility with small in-memory callers.
 */
export function generateHtml(sessionData: SessionData, themeName?: string): string {
	const { prefix, suffix } = generateHtmlParts(themeName);
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");
	return prefix + sessionDataBase64 + suffix;
}

const JSON_TEXT_CHUNK_LENGTH = 16 * 1024;

function writeAll(fd: number, data: string | Uint8Array): void {
	const buffer =
		typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(fd, buffer, offset, buffer.length - offset);
		if (written <= 0) throw new Error("Failed to write HTML export");
		offset += written;
	}
}

function lstatIfExists(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

interface FileIdentity {
	dev: number;
	ino: number;
}

interface OutputTarget {
	sourcePath: string;
	sourceIdentity: FileIdentity;
	requestedPath: string;
	path: string;
	parentPath: string;
	parentIdentity: FileIdentity;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sourceAliasError(): Error {
	return new Error("HTML export output must not overwrite its source session");
}

function inspectExistingOutput(path: string, sourceIdentity: FileIdentity): FileIdentity | undefined {
	const linkStats = lstatIfExists(path);
	if (!linkStats) return undefined;
	if (linkStats.isSymbolicLink()) {
		throw new Error("HTML export output must not replace a symbolic-link destination");
	}
	if (sameIdentity(sourceIdentity, linkStats)) throw sourceAliasError();
	if (!linkStats.isFile()) {
		throw new Error("HTML export output must be a regular file");
	}
	if (linkStats.nlink > 1) {
		throw new Error("HTML export output must not replace a hard-linked destination");
	}
	return { dev: linkStats.dev, ino: linkStats.ino };
}

/**
 * Freeze the physical source and destination directory before any asynchronous
 * rendering. Node does not expose dirfd-relative hard-link operations, so a
 * hostile filesystem can still race a pathname check. A private staging
 * directory, no-clobber link, and surrounding identity checks keep the
 * portable implementation fail-closed under ordinary ownership boundaries.
 */
function resolveOutputTarget(sourcePath: string, outputPath: string): OutputTarget {
	const canonicalSourcePath = realpathSync(resolvePath(sourcePath));
	const sourceStats = statSync(canonicalSourcePath);
	const resolvedOutputPath = resolvePath(outputPath);
	const parentPath = realpathSync(dirname(resolvedOutputPath));
	const parentStats = statSync(parentPath);
	if (!parentStats.isDirectory()) throw new Error("HTML export output parent must be a directory");
	const canonicalOutputPath = join(parentPath, basename(resolvedOutputPath));
	const sourceIdentity = { dev: sourceStats.dev, ino: sourceStats.ino };
	if (canonicalSourcePath === canonicalOutputPath) throw sourceAliasError();
	const existing = inspectExistingOutput(canonicalOutputPath, sourceIdentity);
	if (existing) {
		throw new Error("HTML export output already exists; choose a different path or remove it first");
	}
	return {
		sourcePath: canonicalSourcePath,
		sourceIdentity,
		requestedPath: resolvedOutputPath,
		path: canonicalOutputPath,
		parentPath,
		parentIdentity: { dev: parentStats.dev, ino: parentStats.ino },
	};
}

function reportedOutputPath(target: OutputTarget): string {
	const requested = lstatIfExists(target.requestedPath);
	const published = lstatIfExists(target.path);
	return requested?.isFile() && published?.isFile() && sameIdentity(requested, published)
		? target.requestedPath
		: target.path;
}

function assertOutputTargetUnchanged(target: OutputTarget): void {
	const sourceStats = statSync(target.sourcePath);
	if (!sameIdentity(target.sourceIdentity, sourceStats)) {
		throw new Error("HTML export source changed while exporting");
	}
	const parentStats = statSync(target.parentPath);
	if (!parentStats.isDirectory() || !sameIdentity(target.parentIdentity, parentStats)) {
		throw new Error("HTML export output parent changed while exporting");
	}
	if (inspectExistingOutput(target.path, target.sourceIdentity)) {
		throw new Error("HTML export output changed while exporting");
	}
}

function assertParentIdentity(target: OutputTarget, parentFd?: number): void {
	const parentStats = statSync(target.parentPath);
	if (!parentStats.isDirectory() || !sameIdentity(target.parentIdentity, parentStats)) {
		throw new Error("HTML export output parent changed while exporting");
	}
	if (parentFd !== undefined && !sameIdentity(target.parentIdentity, fstatSync(parentFd))) {
		throw new Error("HTML export output parent changed while exporting");
	}
}

function assertRegularPathIdentity(path: string, expected: FileIdentity, description: string): void {
	const stats = lstatIfExists(path);
	if (!stats || !stats.isFile() || !sameIdentity(expected, stats)) {
		throw new Error(`${description} changed while exporting`);
	}
}

class Base64JsonWriter {
	private carry = Buffer.alloc(0);
	private readonly write: (chunk: string) => void;

	constructor(write: (chunk: string) => void) {
		this.write = write;
	}

	writeJson(value: unknown): void {
		const json = JSON.stringify(value);
		if (json === undefined) throw new TypeError("Cannot serialize undefined as JSON");
		this.writeText(json);
	}

	writeText(text: string): void {
		let offset = 0;
		while (offset < text.length) {
			let end = Math.min(offset + JSON_TEXT_CHUNK_LENGTH, text.length);
			if (end < text.length) {
				const lastCodeUnit = text.charCodeAt(end - 1);
				if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
			}
			this.writeBytes(Buffer.from(text.slice(offset, end)));
			offset = end;
		}
	}

	finish(): void {
		if (this.carry.length > 0) this.write(this.carry.toString("base64"));
		this.carry = Buffer.alloc(0);
	}

	private writeBytes(bytes: Buffer): void {
		if (bytes.length === 0) return;
		const combined = this.carry.length > 0 ? Buffer.concat([this.carry, bytes]) : bytes;
		const completeLength = combined.length - (combined.length % 3);
		if (completeLength > 0) this.write(combined.subarray(0, completeLength).toString("base64"));
		this.carry = Buffer.from(combined.subarray(completeLength));
	}
}

/** Tools rendered directly by the HTML template (not pre-rendered via TUI→ANSI→HTML pipeline) */
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/**
 * Pre-render custom tools to HTML using their TUI renderers.
 */
function preRenderCustomToolEntry(
	entry: SessionEntry,
	toolRenderer: ToolHtmlRenderer,
	renderedTools: RenderedToolsSpool,
): void {
	if (entry.type !== "message") return;
	const msg = entry.message;

	// Find tool calls in assistant messages
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
				const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
				if (callHtml) {
					renderedTools.setCall(block.id, callHtml);
				}
			}
		}
	}

	// Find tool results
	if (msg.role === "toolResult" && msg.toolCallId) {
		const toolName = msg.toolName || "";
		// Only render if we have a pre-rendered call OR it's not template-rendered
		const existing = renderedTools.has(msg.toolCallId);
		if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
			const rendered = toolRenderer.renderResult(
				msg.toolCallId,
				toolName,
				msg.content,
				msg.details,
				msg.isError || false,
			);
			if (rendered) {
				renderedTools.setResult(msg.toolCallId, rendered.collapsed, rendered.expanded);
			}
		}
	}
}

async function preRenderCustomTools(
	sm: SessionManager,
	toolRenderer: ToolHtmlRenderer,
	toOrdinal: number,
): Promise<RenderedToolsSpool | undefined> {
	const renderedTools = new RenderedToolsSpool();
	try {
		renderedTools.begin();
		await sm.iterateEntries({ direction: "forward", toOrdinal }, (entry) => {
			preRenderCustomToolEntry(entry, toolRenderer, renderedTools);
		});
		renderedTools.commit();
		if (renderedTools.isEmpty()) {
			renderedTools.close();
			return undefined;
		}
		return renderedTools;
	} catch (error) {
		try {
			renderedTools.rollback();
		} catch {
			// Preserve the rendering error; close() still removes the spool.
		}
		renderedTools.close();
		throw error;
	}
}

function writeTools(writer: Base64JsonWriter, tools: NonNullable<SessionData["tools"]>): void {
	writer.writeText("[");
	for (let index = 0; index < tools.length; index++) {
		if (index > 0) writer.writeText(",");
		writer.writeJson(tools[index]);
	}
	writer.writeText("]");
}

function writeRenderedTools(writer: Base64JsonWriter, renderedTools: RenderedToolsSpool): void {
	writer.writeText("{");
	let first = true;
	for (const rendered of renderedTools.entries()) {
		if (!first) writer.writeText(",");
		first = false;
		writer.writeJson(rendered.tool_call_id);
		writer.writeText(":");
		writer.writeText("{");
		let firstProperty = true;
		for (const [name, value] of [
			["callHtml", rendered.call_html],
			["resultHtmlCollapsed", rendered.result_html_collapsed],
			["resultHtmlExpanded", rendered.result_html_expanded],
		] as const) {
			if (value === null) continue;
			if (!firstProperty) writer.writeText(",");
			firstProperty = false;
			writer.writeJson(name);
			writer.writeText(":");
			writer.writeJson(value);
		}
		writer.writeText("}");
	}
	writer.writeText("}");
}

async function writeSessionData(
	writer: Base64JsonWriter,
	sm: SessionManager,
	data: StreamingSessionData,
): Promise<void> {
	writer.writeText('{"header":');
	writer.writeJson(data.header);
	writer.writeText(',"entries":[');
	let firstEntry = true;
	await sm.iterateEntries({ direction: "forward", toOrdinal: data.toOrdinal }, (entry) => {
		if (!firstEntry) writer.writeText(",");
		firstEntry = false;
		writer.writeJson(entry);
	});
	writer.writeText('],"leafId":');
	writer.writeJson(data.leafId);
	if (data.systemPrompt !== undefined) {
		writer.writeText(',"systemPrompt":');
		writer.writeJson(data.systemPrompt);
	}
	if (data.tools !== undefined) {
		writer.writeText(',"tools":');
		writeTools(writer, data.tools);
	}
	if (data.renderedTools !== undefined) {
		writer.writeText(',"renderedTools":');
		writeRenderedTools(writer, data.renderedTools);
	}
	writer.writeText("}");
}

async function streamHtml(
	sm: SessionManager,
	data: StreamingSessionData,
	target: OutputTarget,
	themeName?: string,
): Promise<void> {
	const { prefix, suffix } = generateHtmlParts(themeName);
	let stagingRoot = "";
	let tempPath = "";
	let fd: number | undefined;
	let parentFd: number | undefined;
	let tempIdentity: FileIdentity | undefined;
	let stagingCreated = false;
	let tempCreated = false;
	try {
		parentFd = process.platform === "win32" ? undefined : openSync(target.parentPath, "r");
		assertParentIdentity(target, parentFd);
		stagingRoot = mkdtempSync(join(target.parentPath, ".pi-export-"));
		stagingCreated = true;
		tempPath = join(stagingRoot, `${randomUUID()}.tmp`);
		const outputFd = openSync(tempPath, "wx", 0o600);
		fd = outputFd;
		tempCreated = true;
		const tempStats = fstatSync(outputFd);
		tempIdentity = { dev: tempStats.dev, ino: tempStats.ino };
		writeAll(outputFd, prefix);
		const writer = new Base64JsonWriter((chunk) => writeAll(outputFd, chunk));
		await writeSessionData(writer, sm, data);
		data.renderedTools?.close();
		writer.finish();
		writeAll(outputFd, suffix);
		fchmodSync(outputFd, 0o666 & ~process.umask() & 0o777);
		fsyncSync(outputFd);
		sm.assertSessionSourceSnapshot(data.sourceSnapshot);
		assertOutputTargetUnchanged(target);
		assertParentIdentity(target, parentFd);
		assertRegularPathIdentity(tempPath, tempIdentity, "HTML export temporary file");
		linkSync(tempPath, target.path);
		try {
			assertRegularPathIdentity(target.path, tempIdentity, "HTML export publication");
			if (parentFd !== undefined) fsyncSync(parentFd);
			try {
				unlinkSync(tempPath);
				tempCreated = false;
				rmdirSync(stagingRoot);
				stagingCreated = false;
			} catch (cleanupError) {
				process.emitWarning(`HTML export succeeded but could not remove ${tempPath}: ${String(cleanupError)}`);
			}
			if (parentFd !== undefined) fsyncSync(parentFd);
			assertRegularPathIdentity(target.path, tempIdentity, "HTML export publication");
			assertParentIdentity(target, parentFd);
		} catch (error) {
			throw new Error(
				`HTML export publication may exist at ${target.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Preserve the original export error while still attempting temp cleanup.
			}
		}
		if (parentFd !== undefined) {
			try {
				closeSync(parentFd);
			} catch {
				// Preserve the original export result.
			}
		}
		if (tempCreated && tempIdentity) {
			try {
				const stats = lstatIfExists(tempPath);
				if (stats?.isFile() && sameIdentity(tempIdentity, stats)) unlinkSync(tempPath);
			} catch {
				// Best effort only; preserve the original export error.
			}
		}
		if (stagingCreated) {
			try {
				rmdirSync(stagingRoot);
			} catch {
				// Never recurse into a path that may have been replaced.
			}
		}
	}
}

/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}
	const target = resolveOutputTarget(sessionFile, outputPath);
	const toOrdinal = sm.getHistorySummary().entryCount - 1;
	const managerSourceIdentity = sm.getSessionSourceIdentity();
	if (!managerSourceIdentity || !sameIdentity(target.sourceIdentity, managerSourceIdentity)) {
		throw new Error("Cannot export because the session file changed after it was opened");
	}
	const sourceSnapshot = sm.captureSessionSourceSnapshot(toOrdinal);
	const sessionData: StreamingSessionData = {
		header: sm.getHeader(),
		leafId: sm.getLeafId(),
		toOrdinal,
		sourceSnapshot,
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
	};

	let renderedTools: RenderedToolsSpool | undefined;
	try {
		if (opts.toolRenderer) {
			renderedTools = await preRenderCustomTools(sm, opts.toolRenderer, sessionData.toOrdinal);
		}
		sessionData.renderedTools = renderedTools;
		await streamHtml(sm, sessionData, target, opts.themeName);
		return reportedOutputPath(target);
	} finally {
		renderedTools?.close();
	}
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}
	if (statSync(resolvedInputPath).size === 0) {
		throw new Error("Nothing to export - the session file is empty");
	}

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const inputBasename = basename(resolvedInputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}
	// Reject an obvious source alias or occupied destination before opening a
	// legacy file, since open may migrate that file in place.
	resolveOutputTarget(resolvedInputPath, outputPath);

	const sm = SessionManager.open(resolvedInputPath);
	try {
		// Resolve again after open so a legitimate atomic legacy migration is
		// captured, then bind the pathname to the descriptor the manager reads.
		const target = resolveOutputTarget(resolvedInputPath, outputPath);
		const toOrdinal = sm.getHistorySummary().entryCount - 1;
		const managerSourceIdentity = sm.getSessionSourceIdentity();
		if (!managerSourceIdentity || !sameIdentity(target.sourceIdentity, managerSourceIdentity)) {
			throw new Error("Cannot export because the session file changed while it was opened");
		}
		const sourceSnapshot = sm.captureSessionSourceSnapshot(toOrdinal);
		const sessionData: StreamingSessionData = {
			header: sm.getHeader(),
			leafId: sm.getLeafId(),
			toOrdinal,
			sourceSnapshot,
		};
		await streamHtml(sm, sessionData, target, opts.themeName);
		return reportedOutputPath(target);
	} finally {
		sm.close();
	}
}
