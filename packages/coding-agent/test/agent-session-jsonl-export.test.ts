import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-jsonl-export-"));
	roots.push(root);
	return root;
}

function writeLinearSession(path: string, entryCount: number): void {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "export-test",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/project",
	};
	const lines = [JSON.stringify(header)];
	let parentId: string | null = null;
	for (let index = 0; index < entryCount; index++) {
		const id = `message-${index}`;
		const entry: SessionEntry = {
			type: "message",
			id,
			parentId,
			timestamp: new Date(index).toISOString(),
			message: { role: "user", content: `content-${index}`, timestamp: index },
		};
		lines.push(JSON.stringify(entry));
		parentId = id;
	}
	writeFileSync(path, `${lines.join("\n")}\n`);
}

function openManager(path: string): SessionManager {
	const manager = SessionManager.open(path);
	managers.push(manager);
	return manager;
}

function createExporter(sessionManager: SessionManager): AgentSession {
	const session = Object.create(AgentSession.prototype) as AgentSession;
	Object.defineProperty(session, "sessionManager", { value: sessionManager });
	return session;
}

function failDuringIteration(sessionManager: SessionManager): ReturnType<typeof vi.spyOn> {
	const iterateBranchEntries = sessionManager.iterateBranchEntries.bind(sessionManager);
	return vi.spyOn(sessionManager, "iterateBranchEntries").mockImplementation((visitor, fromId) => {
		let visited = 0;
		iterateBranchEntries((entry) => {
			visitor(entry);
			visited++;
			if (visited === 2) throw new Error("injected export failure");
		}, fromId);
	});
}

type AliasKind = "hardlink" | "symlink";

function createAlias(kind: AliasKind, source: string, destination: string): void {
	if (kind === "hardlink") linkSync(source, destination);
	else symlinkSync(source, destination);
}

describe("AgentSession.exportToJsonl", () => {
	it("rejects a large unretained active source path without modifying it", () => {
		const root = createRoot();
		const source = join(root, "session.jsonl");
		writeLinearSession(source, 9000);
		const sourceBefore = readFileSync(source);
		const sessionManager = openManager(source);
		const session = createExporter(sessionManager);

		expect(sessionManager.getHistoryMetrics()).toMatchObject({
			session_active_entries: 9000,
			session_hydration_cache_bytes: 0,
		});
		const filesBefore = readdirSync(root).sort();
		expect(() => session.exportToJsonl(source)).toThrow(
			`Cannot export JSONL over the active session file: ${source}`,
		);
		expect(readFileSync(source)).toEqual(sourceBefore);
		expect(readdirSync(root).sort()).toEqual(filesBefore);
	});

	it("rejects the active source through a parent-directory symlink", () => {
		const root = createRoot();
		const realDirectory = join(root, "real");
		const aliasDirectory = join(root, "alias");
		mkdirSync(realDirectory);
		symlinkSync(realDirectory, aliasDirectory);
		const source = join(realDirectory, "session.jsonl");
		const destination = join(aliasDirectory, "session.jsonl");
		writeLinearSession(source, 3);
		const sourceBefore = readFileSync(source);
		const session = createExporter(openManager(source));
		const filesBefore = readdirSync(realDirectory).sort();

		expect(() => session.exportToJsonl(destination)).toThrow(
			`Cannot export JSONL over the active session file: ${destination}`,
		);
		expect(readFileSync(source)).toEqual(sourceBefore);
		expect(readdirSync(realDirectory).sort()).toEqual(filesBefore);
		expect(lstatSync(aliasDirectory).isSymbolicLink()).toBe(true);
	});

	it.each<AliasKind>(["hardlink", "symlink"])("rejects a %s alias without modifying it or its source", (kind) => {
		const root = createRoot();
		const source = join(root, "session.jsonl");
		const destination = join(root, `${kind}.jsonl`);
		writeLinearSession(source, 3);
		const session = createExporter(openManager(source));
		createAlias(kind, source, destination);
		const sourceBefore = readFileSync(source);
		const aliasBefore = readFileSync(destination);
		const filesBefore = readdirSync(root).sort();

		expect(() => session.exportToJsonl(destination)).toThrow(
			`Cannot export JSONL over the active session file: ${destination}`,
		);
		expect(readFileSync(source)).toEqual(sourceBefore);
		expect(readFileSync(destination)).toEqual(aliasBefore);
		expect(readdirSync(root).sort()).toEqual(filesBefore);
		if (kind === "hardlink") {
			const sourceIdentity = statSync(source);
			const aliasIdentity = statSync(destination);
			expect([aliasIdentity.dev, aliasIdentity.ino]).toEqual([sourceIdentity.dev, sourceIdentity.ino]);
		} else {
			expect(lstatSync(destination).isSymbolicLink()).toBe(true);
			expect(readlinkSync(destination)).toBe(source);
		}
	});

	it("preserves a distinct destination when streaming fails", () => {
		const root = createRoot();
		const source = join(root, "session.jsonl");
		const destination = join(root, "export.jsonl");
		writeLinearSession(source, 3);
		writeFileSync(destination, "existing destination\n");
		const sourceBefore = readFileSync(source);
		const destinationBefore = readFileSync(destination);
		const sessionManager = openManager(source);
		const session = createExporter(sessionManager);
		const filesBefore = readdirSync(root).sort();
		const failure = failDuringIteration(sessionManager);

		expect(() => session.exportToJsonl(destination)).toThrow("injected export failure");
		failure.mockRestore();
		expect(readFileSync(source)).toEqual(sourceBefore);
		expect(readFileSync(destination)).toEqual(destinationBefore);
		expect(readdirSync(root).sort()).toEqual(filesBefore);
	});

	it("exports to a distinct destination without modifying the source", () => {
		const root = createRoot();
		const source = join(root, "session.jsonl");
		const destination = join(root, "export.jsonl");
		writeLinearSession(source, 3);
		const sourceBefore = readFileSync(source);
		const sourceLines = sourceBefore.toString("utf8").trimEnd().split("\n");
		const session = createExporter(openManager(source));

		expect(session.exportToJsonl(destination)).toBe(destination);
		expect(readFileSync(source)).toEqual(sourceBefore);
		const destinationLines = readFileSync(destination, "utf8").trimEnd().split("\n");
		expect(destinationLines).toHaveLength(4);
		expect(JSON.parse(destinationLines[0])).toMatchObject({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "export-test",
		});
		expect(destinationLines.slice(1)).toEqual(sourceLines.slice(1));
		expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
	});
});
