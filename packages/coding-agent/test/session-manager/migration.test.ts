import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FileEntry,
	loadEntriesFromFile,
	migrateSessionEntries,
	type SessionHeader,
	SessionManager,
} from "../../src/core/session-manager.ts";

const roots: string[] = [];
const sessionManagerUrl = new URL("../../src/core/session-manager.ts", import.meta.url).href;
const repoRoot = resolve(import.meta.dirname, "../../../..");

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-legacy-migration-"));
	roots.push(root);
	return root;
}

function header(version?: number): SessionHeader {
	return {
		type: "session",
		...(version === undefined ? {} : { version }),
		id: "legacy-session",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/legacy-project",
	};
}

function v1Message(role: string, content: string, second: number): FileEntry {
	return {
		type: "message",
		timestamp: `2026-01-01T00:00:0${second}.000Z`,
		message: { role, content, timestamp: second },
	} as unknown as FileEntry;
}

function v1Compaction(firstKeptEntryIndex: unknown): FileEntry {
	return {
		type: "compaction",
		timestamp: "2026-01-01T00:00:03.000Z",
		summary: "legacy summary",
		firstKeptEntryIndex,
		tokensBefore: 100,
	} as unknown as FileEntry;
}

function v1Entries(firstKeptEntryIndex: unknown = 2): FileEntry[] {
	return [
		header(),
		v1Message("hookMessage", "hook", 1),
		v1Message("user", "hello", 2),
		v1Compaction(firstKeptEntryIndex),
	];
}

function v2Entries(): FileEntry[] {
	return [
		header(2),
		{
			type: "message",
			id: "v2-first",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "hookMessage", content: "legacy hook", timestamp: 1 },
			extra: { preserved: true },
		} as unknown as FileEntry,
		{
			type: "custom",
			id: "v2-second",
			parentId: "v2-first",
			timestamp: "2026-01-01T00:00:02.000Z",
			customType: "test",
			data: { preserved: true },
		} as FileEntry,
	];
}

function writeEntries(path: string, entries: FileEntry[], noise = false): void {
	const lines: string[] = [];
	for (const [index, entry] of entries.entries()) {
		lines.push(JSON.stringify(entry));
		if (noise && index < entries.length - 1) lines.push(index % 2 === 0 ? "not-json" : "");
	}
	writeFileSync(path, `${lines.join("\n")}\n`);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function migrationDebris(root: string): string[] {
	return readdirSync(root)
		.filter((name) => name.endsWith(".lock") || name.includes(".migrate.") || name.includes(".fork."))
		.sort();
}

interface ChildRun {
	ready: Promise<void>;
	done: Promise<string>;
}

function launchWorker(workerPath: string, args: string[], nodeArgs: string[] = []): ChildRun {
	const child = spawn(process.execPath, [...nodeArgs, "--import", "tsx", workerPath, ...args], {
		cwd: repoRoot,
		env: { ...process.env, PI_OFFLINE: "1", TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let ready = false;
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolveReady = resolvePromise;
		rejectReady = rejectPromise;
	});
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
		if (!ready && stdout.includes("ready\n")) {
			ready = true;
			resolveReady?.();
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const done = new Promise<string>((resolvePromise, rejectPromise) => {
		child.once("error", (error) => {
			rejectReady?.(error);
			rejectPromise(error);
		});
		child.once("exit", (code) => {
			if (!ready) rejectReady?.(new Error(`worker exited before ready (${code}): ${stderr}`));
			if (code === 0) resolvePromise(stdout.trim().split("\n").at(-1) ?? "");
			else rejectPromise(new Error(`worker exited ${code}: ${stderr}`));
		});
	});
	return { ready: readyPromise, done };
}

describe("legacy session migration", () => {
	it("migrates v1 deterministically with logical ordinals and file parity", () => {
		const expected = structuredClone(v1Entries());
		const retry = structuredClone(v1Entries());
		migrateSessionEntries(expected);
		migrateSessionEntries(retry);
		expect(retry).toEqual(expected);

		const body = expected.slice(1) as unknown as Array<Record<string, unknown>>;
		const ids = body.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(body.length);
		expect(body.map((entry) => entry.parentId)).toEqual([null, ids[0], ids[1]]);
		expect((expected[0] as SessionHeader).version).toBe(3);
		expect((body[0].message as Record<string, unknown>).role).toBe("custom");
		expect(body[2].firstKeptEntryId).toBe(ids[1]);
		expect(body[2]).not.toHaveProperty("firstKeptEntryIndex");

		const root = createRoot();
		for (const noisy of [false, true]) {
			const path = join(root, noisy ? "noisy.jsonl" : "clean.jsonl");
			writeEntries(path, v1Entries(), noisy);
			chmodSync(path, 0o640);
			const manager = SessionManager.open(path, root);
			manager.close();
			expect(loadEntriesFromFile(path)).toEqual(expected);
			expect(statSync(path).mode & 0o777).toBe(0o640);
			const migratedHash = sha256(path);
			SessionManager.open(path, root).close();
			expect(sha256(path)).toBe(migratedHash);
		}
		expect(migrationDebris(root)).toEqual([]);
	});

	it("migrates v2 without changing ids, parents, or unrelated fields", () => {
		const entries = v2Entries();
		const expected = structuredClone(entries);
		(expected[0] as SessionHeader).version = 3;
		(expected[1] as unknown as { message: Record<string, unknown> }).message.role = "custom";

		migrateSessionEntries(entries);
		expect(entries).toEqual(expected);

		const root = createRoot();
		const path = join(root, "v2.jsonl");
		writeEntries(path, v2Entries(), true);
		SessionManager.open(path, root).close();
		expect(loadEntriesFromFile(path)).toEqual(expected);
		expect(migrationDebris(root)).toEqual([]);
	});

	it.each([1, 2] as const)("retains legacy v%s custom-message null content", (version) => {
		const entry = {
			type: "custom_message",
			...(version === 2 ? { id: "legacy-custom", parentId: null } : {}),
			timestamp: "2026-01-01T00:00:01.000Z",
			customType: "legacy-null",
			content: null,
			display: true,
		} as unknown as FileEntry;
		const entries = [header(version === 1 ? undefined : 2), entry];
		const migrated = structuredClone(entries);
		migrateSessionEntries(migrated);
		expect((migrated[1] as unknown as { content: unknown }).content).toBeNull();

		const root = createRoot();
		const path = join(root, `custom-null-v${version}.jsonl`);
		writeEntries(path, entries);
		const manager = SessionManager.open(path, root);
		expect((manager.getEntries()[0] as unknown as { content: unknown }).content).toBeNull();
		expect(manager.buildSessionContext().messages[0]).toMatchObject({
			role: "custom",
			customType: "legacy-null",
			content: [],
		});
		manager.close();
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null, 4])(
		"rejects invalid firstKeptEntryIndex %s",
		(value) => {
			const entries = v1Entries(value);
			expect(() => migrateSessionEntries(entries)).toThrow("firstKeptEntryIndex");
		},
	);

	it("rejects a legacy compaction marker that points to a later entry", () => {
		const entries = [header(), v1Message("user", "before", 1), v1Compaction(3), v1Message("user", "later", 4)];
		expect(() => migrateSessionEntries(entries)).toThrow("firstKeptEntryIndex 3 must precede compaction entry 2");
	});

	it.each(["open", "fork"] as const)(
		"leaves the source and directory unchanged after terminal semantic failure during %s",
		(operation) => {
			const root = createRoot();
			const path = join(root, `${operation}-invalid.jsonl`);
			writeEntries(path, v1Entries(4), true);
			chmodSync(path, 0o640);
			const beforeHash = sha256(path);
			const beforeMode = statSync(path).mode & 0o777;
			const beforeFiles = readdirSync(root).sort();

			const run = () =>
				operation === "open"
					? SessionManager.open(path, root).close()
					: SessionManager.forkFrom(path, root, root, { id: "invalid-fork" }).close();
			expect(run).toThrow("firstKeptEntryIndex");
			expect(sha256(path)).toBe(beforeHash);
			expect(statSync(path).mode & 0o777).toBe(beforeMode);
			expect(readdirSync(root).sort()).toEqual(beforeFiles);
		},
	);

	it.each(["open", "fork"] as const)(
		"preserves the source when a legacy compaction marker points forward during %s",
		(operation) => {
			const root = createRoot();
			const path = join(root, `${operation}-future.jsonl`);
			writeEntries(path, [header(), v1Message("user", "before", 1), v1Compaction(3), v1Message("user", "later", 4)]);
			const beforeHash = sha256(path);
			const beforeFiles = readdirSync(root).sort();

			const run = () =>
				operation === "open"
					? SessionManager.open(path, root).close()
					: SessionManager.forkFrom(path, root, root, { id: "future-fork" }).close();
			expect(run).toThrow("firstKeptEntryIndex 3 must precede compaction entry 2");
			expect(sha256(path)).toBe(beforeHash);
			expect(readdirSync(root).sort()).toEqual(beforeFiles);
		},
	);

	it("does not publish a migration after a mid-stream entry validation failure", () => {
		const root = createRoot();
		const path = join(root, "invalid-entry.jsonl");
		writeEntries(path, [
			header(),
			v1Message("user", "valid", 1),
			{
				type: "message",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { content: "missing role" },
			} as unknown as FileEntry,
		]);
		const beforeHash = sha256(path);
		const beforeFiles = readdirSync(root).sort();

		expect(() => SessionManager.open(path, root)).toThrow("invalid legacy entry");
		expect(sha256(path)).toBe(beforeHash);
		expect(readdirSync(root).sort()).toEqual(beforeFiles);
	});

	it.each([
		["v1", v1Entries()],
		["v2", v2Entries()],
	] as const)("forks %s into a normalized atomic destination without changing the source", (_version, source) => {
		const root = createRoot();
		const path = join(root, `${_version}-source.jsonl`);
		writeEntries(path, structuredClone(source), true);
		chmodSync(path, 0o640);
		const beforeHash = sha256(path);
		const expected = structuredClone(source) as FileEntry[];
		migrateSessionEntries(expected);

		const forked = SessionManager.forkFrom(path, root, root, { id: `${_version}-fork` });
		const destination = forked.getSessionFile();
		expect(destination).toBeDefined();
		forked.close();
		expect(sha256(path)).toBe(beforeHash);
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect((loadEntriesFromFile(path)[0] as SessionHeader).version).toBe(_version === "v1" ? undefined : 2);

		const destinationEntries = loadEntriesFromFile(destination!);
		expect(destinationEntries.slice(1)).toEqual(expected.slice(1));
		expect(destinationEntries[0]).toMatchObject({
			type: "session",
			version: 3,
			id: `${_version}-fork`,
			cwd: root,
			parentSession: path,
		});
		expect(migrationDebris(root)).toEqual([]);
	});

	it("never replaces an existing fork destination", () => {
		const root = createRoot();
		const source = join(root, "source.jsonl");
		writeEntries(source, [header(3), v1Message("user", "hello", 1)]);
		const now = new Date("2026-03-04T05:06:07.008Z");
		const destination = join(root, "2026-03-04T05-06-07-008Z_no-clobber.jsonl");
		writeFileSync(destination, "rival\n");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		try {
			expect(() => SessionManager.forkFrom(source, root, root, { id: "no-clobber" })).toThrow(
				"Session file already exists",
			);
		} finally {
			vi.useRealTimers();
		}
		expect(readFileSync(destination, "utf8")).toBe("rival\n");
		expect(migrationDebris(root)).toEqual([]);
	});

	it("serializes simultaneous v1 opens across processes", async () => {
		const root = createRoot();
		const path = join(root, "simultaneous.jsonl");
		const startPath = join(root, "start");
		const workerPath = join(root, "open-worker.ts");
		const entries: FileEntry[] = [header()];
		for (let index = 0; index < 5000; index++) entries.push(v1Message("user", `message-${index}`, index % 9));
		writeEntries(path, entries);
		const expected = structuredClone(entries);
		migrateSessionEntries(expected);
		writeFileSync(
			workerPath,
			`import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
const [path, startPath] = process.argv.slice(2);
const waiter = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\\n");
while (!existsSync(startPath)) Atomics.wait(waiter, 0, 0, 5);
const manager = SessionManager.open(path);
const result = {
  id: manager.getSessionId(),
  version: manager.getHeader()?.version,
  entries: manager.getHistorySummary().entryCount,
};
manager.close();
process.stdout.write(JSON.stringify({ ...result, hash: createHash("sha256").update(readFileSync(path)).digest("hex") }) + "\\n");
`,
		);

		const first = launchWorker(workerPath, [path, startPath]);
		const second = launchWorker(workerPath, [path, startPath]);
		await Promise.all([first.ready, second.ready]);
		writeFileSync(startPath, "start");
		const results = (await Promise.all([first.done, second.done])).map((line) => JSON.parse(line));
		expect(results[0]).toEqual(results[1]);
		expect(results[0]).toMatchObject({ id: "legacy-session", version: 3, entries: 5000 });
		expect(loadEntriesFromFile(path)).toEqual(expected);
		const migratedHash = sha256(path);
		SessionManager.open(path).close();
		expect(sha256(path)).toBe(migratedHash);
		expect(migrationDebris(root)).toEqual([]);
	}, 30_000);

	it("migrates many records under a constrained heap", async () => {
		const root = createRoot();
		const path = join(root, "large-v1.jsonl");
		const workerPath = join(root, "heap-worker.ts");
		const recordCount = 20_000;
		const fd = openSync(path, "wx");
		try {
			writeFileSync(fd, `${JSON.stringify(header())}\n`);
			const data = "x".repeat(4096);
			for (let index = 0; index < recordCount; index++) {
				writeFileSync(
					fd,
					`${JSON.stringify({
						type: "custom",
						timestamp: new Date(index).toISOString(),
						customType: "heap",
						data,
					})}\n`,
				);
			}
		} finally {
			closeSync(fd);
		}
		writeFileSync(
			workerPath,
			`import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};
const manager = SessionManager.open(process.argv[2]);
const result = { version: manager.getHeader()?.version, entries: manager.getHistorySummary().entryCount };
manager.close();
process.stdout.write("ready\\n" + JSON.stringify(result) + "\\n");
`,
		);

		const worker = launchWorker(workerPath, [path], ["--max-old-space-size=64"]);
		await worker.ready;
		expect(JSON.parse(await worker.done)).toEqual({ version: 3, entries: recordCount });
		expect(statSync(path).size).toBeGreaterThan(64 * 1024 * 1024);
		expect(migrationDebris(root)).toEqual([]);
	}, 90_000);
});
