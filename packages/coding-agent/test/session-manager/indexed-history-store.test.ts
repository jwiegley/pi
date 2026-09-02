import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSourceLock, IndexedJsonlSessionHistoryStore } from "../../src/core/session-history-store.ts";
import {
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";
import { DatabaseSync } from "../../src/core/sqlite.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-indexed-history-"));
	roots.push(root);
	return root;
}

function header(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "session-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/project",
	};
}

function custom(id: string, parentId: string | null, data: unknown, customType = "test"): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
		customType,
		data,
	};
}

function compaction(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-01-01T00:01:00.000Z",
		summary: "bounded summary",
		firstKeptEntryId,
		tokensBefore: 10_000,
	};
}

function assistant(id: string, parentId: string | null, input: number, cacheRead: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input,
				output: 3,
				cacheRead,
				cacheWrite: 2,
				totalTokens: input + cacheRead + 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function user(id: string, parentId: string | null, content: string, timestamp: number): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content, timestamp },
	};
}

function writeSession(path: string, entries: FileEntry[], finalNewline = true): void {
	const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + (finalNewline ? "\n" : "");
	writeFileSync(path, text);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("IndexedJsonlSessionHistoryStore", () => {
	it("hydrates only the active compaction projection while retaining historical lookup", () => {
		const path = join(createRoot(), "session.jsonl");
		const huge = "x".repeat(2 * 1024 * 1024);
		writeSession(path, [
			header(),
			custom("01", null, huge),
			custom("02", "01", huge),
			custom("03", "02", "kept"),
			compaction("04", "03", "03"),
			custom("05", "04", "after"),
		]);

		const store = IndexedJsonlSessionHistoryStore.open(path, 1024);
		expect(store.getActiveContextEntries().map((entry) => entry.id)).toEqual(["04", "03", "05"]);
		expect(store.getEntry("01")).toMatchObject({ id: "01", type: "custom" });
		const metrics = store.getMetrics();
		expect(metrics.session_index_entries).toBe(5);
		expect(metrics.session_active_entries).toBe(3);
		expect(metrics.session_active_payload_bytes).toBeLessThan(4096);
		expect(metrics.session_hydration_cache_bytes).toBe(0);
		store.close();
	});

	it("iterates a compacted context newest-first in exact presentation order", () => {
		const path = join(createRoot(), "reverse-context.jsonl");
		writeSession(path, [
			header(),
			user("01", null, "summarized", 1),
			user("02", "01", "retained", 2),
			compaction("03", "02", "02"),
			user("04", "03", "tail", 4),
		]);

		const manager = SessionManager.open(path);
		const source = manager.buildSessionContextSource().messages;
		expect(source.materialize().map((message) => message.role)).toEqual(["compactionSummary", "user", "user"]);
		expect(
			Array.from(source.iterateReverse(), (message) => (message.role === "user" ? message.content : message.role)),
		).toEqual(["tail", "retained", "compactionSummary"]);
		manager.close();
	});

	it("fails closed when a compaction first-kept marker is not on its ancestry", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			custom("01", null, "summarized"),
			custom("02", "01", "also-summarized"),
			compaction("03", "02", "missing"),
			custom("04", "03", "after"),
		]);

		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getActiveContextEntries().map((entry) => entry.id)).toEqual(["03", "04"]);
		expect(store.getMetrics()).toMatchObject({
			session_active_entries: 2,
		});
		store.close();
	});

	it("catches up a JSONL append that committed before its index update", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = first.indexPath;
		const indexInode = statSync(indexPath).ino;
		first.close();

		appendFileSync(path, `${JSON.stringify(custom("02", "01", "crash-window"))}\n`);
		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ id: "02", parentId: "01" });
		expect(reopened.leafId).toBe("02");
		expect(reopened.getMetrics().session_index_entries).toBe(2);
		expect(reopened.indexPath).toBe(indexPath);
		expect(statSync(indexPath).ino).toBe(indexInode);
		reopened.close();
	});

	it("catches up a durable raw append in a live store without replacing its sidecar", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		const indexInode = statSync(store.indexPath).ino;

		appendFileSync(path, `${JSON.stringify(custom("02", "01", "crash-window"))}\n`);
		store.flush();

		expect(store.getEntry("02")).toMatchObject({ id: "02", parentId: "01" });
		expect(store.getHistorySummary().entryCount).toBe(2);
		expect(statSync(store.indexPath).ino).toBe(indexInode);
		store.close();
	});

	it("keeps a byte-identical index across source metadata drift", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "unchanged")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = first.indexPath;
		const indexInode = statSync(indexPath).ino;
		first.close();

		let stats = statSync(path);
		utimesSync(path, stats.atime, new Date(stats.mtimeMs + 1000));
		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(statSync(indexPath).ino).toBe(indexInode);

		stats = statSync(path);
		utimesSync(path, stats.atime, new Date(stats.mtimeMs + 1000));
		expect(() => reopened.flush()).not.toThrow();
		expect(reopened.getEntry("01")).toMatchObject({ data: "unchanged" });
		reopened.close();
	});

	it("continues checkpoint appends after foreign filesystem identity metadata", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		const indexInode = statSync(store.indexPath).ino;
		const source = statSync(path);
		const db = new DatabaseSync(store.indexPath);
		db.prepare("UPDATE source_state SET source_dev = ?, source_ino = ? WHERE singleton = 1").run(
			source.dev + 1,
			source.ino + 1,
		);
		db.close();

		expect(() => store.append(custom("02", "01", "checkpoint"))).not.toThrow();
		expect(store.getEntry("02")).toMatchObject({ id: "02", parentId: "01", data: "checkpoint" });
		expect(store.getSourceIdentity()).toEqual({ dev: statSync(path).dev, ino: statSync(path).ino });
		expect(statSync(store.indexPath).ino).toBe(indexInode);
		store.close();
	});

	it("rebinds a live reader after byte-identical atomic source replacement", () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const replacementPath = join(root, "replacement.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		const indexInode = statSync(store.indexPath).ino;
		const originalIdentity = store.getSourceIdentity();
		writeFileSync(replacementPath, readFileSync(path));
		renameSync(replacementPath, path);
		const replacement = statSync(path);
		expect({ dev: replacement.dev, ino: replacement.ino }).not.toEqual(originalIdentity);

		expect(() => store.flush()).not.toThrow();
		expect(store.getSourceIdentity()).toEqual({ dev: replacement.dev, ino: replacement.ino });
		expect(() => store.append(custom("02", "01", "after-rebind"))).not.toThrow();
		expect(store.getEntry("02")).toMatchObject({ id: "02", parentId: "01", data: "after-rebind" });
		expect(statSync(store.indexPath).ino).toBe(indexInode);
		store.close();
	});

	it("verifies a replacement opened at the append boundary", async () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const replacementPath = join(root, "replacement.jsonl");
		const workerPath = join(root, "replace-on-append.ts");
		writeSession(path, [header(), custom("01", null, "first")]);
		writeFileSync(
			workerPath,
			`import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			const [targetPath, replacementPath] = process.argv.slice(2);
			const path = fs.realpathSync(targetPath);
			const originalOpenSync = fs.openSync;
			let replaced = false;
			fs.openSync = function(pathArg, flags, mode) {
			  if (!replaced && pathArg === path && flags === "a+") {
			    fs.writeFileSync(replacementPath, fs.readFileSync(path));
			    fs.renameSync(replacementPath, path);
			    replaced = true;
			  }
			  return mode === undefined ? originalOpenSync(pathArg, flags) : originalOpenSync(pathArg, flags, mode);
			};
			syncBuiltinESMExports();
			const { IndexedJsonlSessionHistoryStore } = await import(${JSON.stringify(new URL("../../src/core/session-history-store.ts", import.meta.url).href)});
			const store = IndexedJsonlSessionHistoryStore.open(path);
			store.append({
			  type: "custom", id: "02", parentId: "01", timestamp: "2026-01-01T00:00:02.000Z",
			  customType: "test", data: "append-boundary",
			});
			process.stdout.write("replaced=" + replaced + ":entry=" + store.getEntry("02")?.id + "\\n");
			store.close();
			`,
		);

		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, path, replacementPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
			child.once("error", reject);
		});
		expect(stdout).toContain("replaced=true:entry=02");
		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ data: "append-boundary" });
		reopened.close();
	});

	it("preserves a verified append when descriptor close reports failure", async () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const workerPath = join(root, "close-failure-after-append.ts");
		writeSession(path, [header(), custom("01", null, "first")]);
		writeFileSync(
			workerPath,
			`import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			const path = fs.realpathSync(process.argv[2]);
			const originalOpenSync = fs.openSync;
			const originalCloseSync = fs.closeSync;
			let appendFd = -1;
			let injected = false;
			fs.openSync = function(pathArg, flags, mode) {
			  const fd = mode === undefined ? originalOpenSync(pathArg, flags) : originalOpenSync(pathArg, flags, mode);
			  if (pathArg === path && flags === "a+") appendFd = fd;
			  return fd;
			};
			fs.closeSync = function(fd) {
			  const result = originalCloseSync(fd);
			  if (!injected && fd === appendFd) { injected = true; throw new Error("injected-close-after-append"); }
			  return result;
			};
			syncBuiltinESMExports();
			const { IndexedJsonlSessionHistoryStore } = await import(${JSON.stringify(new URL("../../src/core/session-history-store.ts", import.meta.url).href)});
			const store = IndexedJsonlSessionHistoryStore.open(path);
			store.append({
			  type: "custom", id: "02", parentId: "01", timestamp: "2026-01-01T00:00:02.000Z",
			  customType: "test", data: "close-failure",
			});
			process.stdout.write("injected=" + injected + ":entry=" + store.getEntry("02")?.id + "\\n");
			store.close();
			`,
		);
		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, path], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
			child.once("error", reject);
		});
		expect(stdout).toContain("injected=true:entry=02");
		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ data: "close-failure" });
		reopened.close();
	});

	it("rejects an identity-replaced mutated indexed prefix", () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const replacementPath = join(root, "replacement.jsonl");
		writeSession(path, [header(), custom("01", null, "first"), custom("02", "01", "middle")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		const before = readFileSync(path, "utf8");
		const edited = before.replace('"data":"middle"', '"data":"edited"');
		expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(before));
		writeFileSync(replacementPath, edited);
		renameSync(replacementPath, path);

		expect(() => store.flush()).toThrow("changed outside the indexed writer");
		expect(store.getEntry("02")).toMatchObject({ data: "middle" });
		store.close();

		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ data: "edited" });
		reopened.close();
	});

	it("retries catch-up when the source grows after its size snapshot", async () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const releasePath = join(root, "release-catch-up");
		const workerPath = join(root, "catch-up-worker.ts");
		writeSession(path, [header(), custom("01", null, "first")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = first.indexPath;
		const indexInode = statSync(indexPath).ino;
		first.close();
		appendFileSync(path, `${JSON.stringify(custom("02", "01", "before-snapshot"))}\n`);

		writeFileSync(
			workerPath,
			`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [path, releasePath] = process.argv.slice(2);
const originalStatSync = fs.statSync;
let sourceSnapshots = 0;
fs.statSync = ((...args) => {
  const state = originalStatSync(...args);
  const options = args[1];
  if (options && typeof options === "object" && options.bigint === true && ++sourceSnapshots === 2) {
    process.stdout.write("snapshotted\\n");
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 5);
  }
  return state;
});
syncBuiltinESMExports();
const { IndexedJsonlSessionHistoryStore } = await import(${JSON.stringify(new URL("../../src/core/session-history-store.ts", import.meta.url).href)});
const store = IndexedJsonlSessionHistoryStore.open(path);
process.stdout.write("opened:" + store.leafId + ":" + store.getHistorySummary().entryCount + "\\n");
store.close();
`,
		);

		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, path, releasePath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			const inspect = () => {
				if (stdout.includes("snapshotted")) resolve();
			};
			child.stdout.on("data", inspect);
			child.once("error", reject);
			child.once("exit", (code) => {
				inspect();
				if (!stdout.includes("snapshotted")) reject(new Error(`worker exited ${code}: ${stderr}`));
			});
			inspect();
		});

		appendFileSync(path, `${JSON.stringify(custom("03", "02", "after-snapshot"))}\n`);
		writeFileSync(releasePath, "continue");
		await new Promise<void>((resolve, reject) => {
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
			child.once("error", reject);
		});
		expect(stdout).toContain("opened:03:3");

		const db = new DatabaseSync(indexPath);
		const state = db
			.prepare("SELECT indexed_length, entry_count, current_leaf_id, final_line_terminated FROM source_state")
			.get() as {
			indexed_length: number;
			entry_count: number;
			current_leaf_id: string;
			final_line_terminated: number;
		};
		db.close();
		expect(state).toEqual({
			indexed_length: statSync(path).size,
			entry_count: 3,
			current_leaf_id: "03",
			final_line_terminated: 1,
		});

		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("03")).toMatchObject({ parentId: "02", data: "after-snapshot" });
		expect(reopened.leafId).toBe("03");
		expect(reopened.indexPath).toBe(indexPath);
		expect(statSync(indexPath).ino).toBe(indexInode);
		reopened.close();
	}, 30_000);

	it("rebuilds after an equal-length edit to an indexed prefix", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			custom("01", null, "first"),
			custom("02", "01", "middle"),
			custom("03", "02", "last"),
		]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		first.close();

		const before = readFileSync(path, "utf8");
		const after = before.replace('"id":"02","parentId":"01"', '"id":"02","parentId":"99"');
		expect(after).not.toBe(before);
		expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
		writeFileSync(path, after);

		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntryMetadata("02")?.parentId).toBe("99");
		expect(reopened.getBranch("02").map((entry) => entry.id)).toEqual(["02"]);
		reopened.close();
	});

	it("rejects edit-plus-growth catch-up and rebuilds from JSONL on reopen", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			custom("01", null, "first"),
			custom("02", "01", "middle"),
			custom("03", "02", "last"),
		]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		const before = readFileSync(path, "utf8");
		const edited = before.replace('"data":"middle"', '"data":"edited"');
		expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(before));
		writeFileSync(path, `${edited}${JSON.stringify(custom("04", "03", "appended"))}\n`);

		expect(() => store.flush()).toThrow("changed outside the indexed writer");
		expect(store.getEntry("02")).toMatchObject({ data: "middle" });
		store.close();

		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ data: "edited" });
		expect(reopened.getEntry("04")).toMatchObject({ data: "appended" });
		reopened.close();
	});

	it("uses a disposable temporary index for a readable session in an unwritable directory", () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		writeSession(path, [header(), custom("01", null, "read-only")]);
		chmodSync(path, 0o444);
		chmodSync(root, 0o555);
		let temporaryRoot: string | undefined;
		try {
			const store = IndexedJsonlSessionHistoryStore.open(path);
			temporaryRoot = dirname(store.indexPath);
			expect(store.getEntry("01")).toMatchObject({ id: "01" });
			expect(store.indexPath).not.toBe(`${path}.index.sqlite`);
			store.close();
			expect(existsSync(temporaryRoot)).toBe(false);
		} finally {
			chmodSync(root, 0o755);
			chmodSync(path, 0o644);
			if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("falls back to a disposable index when the existing sidecar is read-only", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "read-only-index")]);
		const initial = IndexedJsonlSessionHistoryStore.open(path);
		const sidecarPath = initial.indexPath;
		initial.close();
		chmodSync(sidecarPath, 0o444);
		let temporaryRoot: string | undefined;
		try {
			const store = IndexedJsonlSessionHistoryStore.open(path);
			temporaryRoot = dirname(store.indexPath);
			expect(store.indexPath).not.toBe(sidecarPath);
			expect(store.getEntry("01")).toMatchObject({ id: "01" });
			store.close();
			expect(existsSync(temporaryRoot)).toBe(false);
		} finally {
			chmodSync(sidecarPath, 0o644);
			if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("skips malformed typed records without making the session unopenable", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			custom("01", null, "valid"),
			{ type: "message", id: "bad", parentId: "01", timestamp: "2026-01-01T00:00:02.000Z" } as FileEntry,
			custom("02", "01", "also-valid"),
		]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getHistorySummary().entryCount).toBe(2);
		expect(store.getEntry("bad")).toBeUndefined();
		expect(store.getBranch("02").map((entry) => entry.id)).toEqual(["01", "02"]);
		store.close();
	});

	it("indexes the exact serialized append without rereading the caller's object", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		let customTypeReads = 0;
		const entry = {
			type: "custom",
			id: "02",
			parentId: "01",
			timestamp: "2026-01-01T00:00:02.000Z",
			get customType() {
				customTypeReads++;
				if (customTypeReads === 1) return "serialized-once";
				throw new Error("caller object was reread after serialization");
			},
			data: "durable",
		} as SessionEntry;
		store.append(entry);
		expect(customTypeReads).toBe(1);
		expect(store.getHistorySummary().entryCount).toBe(2);
		expect(store.getEntry("02")).toMatchObject({ customType: "serialized-once", data: "durable" });
		expect(readFileSync(path, "utf8").match(/"id":"02"/g)).toHaveLength(1);
		store.close();

		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ customType: "serialized-once", data: "durable" });
		reopened.close();
	});

	it("preserves an unrecognized sidecar collision and uses a disposable index", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const indexPath = `${path}.index.sqlite`;
		writeFileSync(indexPath, "not sqlite");

		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.indexPath).not.toBe(indexPath);
		expect(store.getEntry("01")).toMatchObject({ id: "01" });
		expect(readFileSync(indexPath, "utf8")).toBe("not sqlite");
		store.close();
	});

	it("rebuilds a recognized sidecar with missing schema", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = first.indexPath;
		first.close();
		const db = new DatabaseSync(indexPath);
		db.exec("DROP TABLE entries");
		db.close();

		const rebuilt = IndexedJsonlSessionHistoryStore.open(path);
		expect(rebuilt.indexPath).toBe(indexPath);
		expect(rebuilt.getEntry("01")).toMatchObject({ id: "01" });
		rebuilt.close();
	});

	it("rebuilds a recognized sidecar with an unsafe persisted length", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = first.indexPath;
		first.close();
		const db = new DatabaseSync(indexPath);
		db.exec("UPDATE source_state SET header_length = 67108865");
		db.close();

		const rebuilt = IndexedJsonlSessionHistoryStore.open(path);
		expect(rebuilt.getEntry("01")).toMatchObject({ id: "01" });
		rebuilt.close();
	});

	it("rebuilds a recognized sidecar whose stored header location is semantically invalid", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = first.indexPath;
		first.close();
		const db = new DatabaseSync(indexPath);
		db.exec(`
			UPDATE source_state
			SET header_offset = (SELECT offset FROM entries WHERE ordinal = 0),
				header_length = (SELECT length FROM entries WHERE ordinal = 0)
		`);
		db.close();

		const rebuilt = IndexedJsonlSessionHistoryStore.open(path);
		expect(rebuilt.header.id).toBe("session-1");
		expect(rebuilt.getEntry("01")).toMatchObject({ id: "01", data: "first" });
		rebuilt.close();
	});

	it("preserves a torn final line and appends the next valid entry independently", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		appendFileSync(path, '{"type":"custom","id":"torn"');
		const tornBytes = readFileSync(path);

		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getEntry("torn")).toBeUndefined();
		store.append(custom("02", "01", "after-torn"));
		store.close();

		const after = readFileSync(path);
		expect(after.subarray(0, tornBytes.length).equals(tornBytes)).toBe(true);
		expect(after.toString("utf8")).toContain('"id":"torn"\n{"type":"custom"');
		const reopened = IndexedJsonlSessionHistoryStore.open(path);
		expect(reopened.getEntry("02")).toMatchObject({ id: "02", data: "after-torn" });
		reopened.close();
	});

	it("indexes a valid final record without LF and seals it before append", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")], false);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getEntry("01")).toMatchObject({ id: "01" });
		store.append(custom("02", "01", "second"));
		store.close();
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[1])).toMatchObject({ id: "01" });
		expect(JSON.parse(lines[2])).toMatchObject({ id: "02", parentId: "01" });
	});

	it("skips malformed middle lines and preserves duplicate-id last-entry semantics", () => {
		const path = join(createRoot(), "session.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify(header()),
				JSON.stringify(custom("same", null, "old")),
				"not-json",
				JSON.stringify(custom("same", null, "new")),
				"",
			].join("\n"),
		);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getEntry("same")).toMatchObject({ data: "new" });
		expect(store.getMetrics().session_index_entries).toBe(2);
		store.close();
	});

	it("recovers when the sidecar is missing", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		const indexPath = store.indexPath;
		store.close();
		rmSync(indexPath);
		expect(existsSync(indexPath)).toBe(false);
		const rebuilt = IndexedJsonlSessionHistoryStore.open(path);
		expect(rebuilt.getEntry("01")).toBeDefined();
		rebuilt.close();
	});

	it("evicts pre-compaction active payloads after a live compaction append", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "old"), custom("02", "01", "kept")]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		store.append(compaction("03", "02", "02"));
		expect(store.getActiveContextEntries().map((entry) => entry.id)).toEqual(["03", "02"]);
		const metrics = store.getMetrics();
		expect(metrics.session_compaction_evicted_entries).toBeGreaterThanOrEqual(1);
		expect(metrics.session_compaction_evicted_bytes).toBeGreaterThan(0);
		store.close();
	});

	it("finds active extension state through compaction and ignores abandoned branches", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			custom("01", null, "active-state", "state"),
			custom("02", "01", "kept"),
			compaction("03", "02", "02"),
			custom("04", "03", "active-tail"),
			custom("05", "01", "abandoned-state", "state"),
		]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		store.setVolatileLeaf("04");
		expect(store.getLatestCustomEntry("state", "all")).toMatchObject({ id: "05" });
		expect(store.getLatestCustomEntry("state", "active")).toMatchObject({ id: "01" });
		store.close();
	});

	it("finds the latest message on the selected branch", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			assistant("01", null, 1, 0),
			custom("02", "01", "active-tail"),
			assistant("03", "01", 1, 0),
		]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		store.setVolatileLeaf("02");
		expect(store.getLatestMessage("assistant")).toMatchObject({ id: "03" });
		expect(store.getLatestMessage("assistant", "active")).toMatchObject({ id: "01" });
		store.close();
	});

	it("reads a bounded recent active slice after a checkpoint", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			custom("01", null, "old", "thread"),
			custom("02", "01", "reset", "reset"),
			custom("03", "02", "new-1", "thread"),
			custom("04", "03", "other", "other"),
			custom("05", "04", "new-2", "thread"),
			custom("06", "01", "abandoned", "thread"),
		]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		store.setVolatileLeaf("05");
		expect(store.getRecentActiveEntries({ customType: "thread", stopBeforeId: "02", limit: 2 })).toMatchObject([
			{ id: "03", data: "new-1" },
			{ id: "05", data: "new-2" },
		]);
		expect(store.getRecentActiveEntries({ customType: "thread", stopBeforeId: "02", limit: 1 })).toMatchObject([
			{ id: "05", data: "new-2" },
		]);
		store.close();
	});

	it("indexes stable transcript ordinals and honors a total iteration limit", async () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			assistant("01", null, 1, 0),
			custom("02", "01", "between"),
			assistant("03", "02", 1, 0),
			assistant("04", "03", 1, 0),
		]);
		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getMessageByOrdinal(0)).toMatchObject({ id: "01" });
		expect(store.getMessageByOrdinal(1)).toMatchObject({ id: "03" });
		expect(store.getMessageByOrdinal(2)).toMatchObject({ id: "04" });
		expect(store.getMessageByOrdinal(3)).toBeUndefined();

		const visited: Array<{ id: string; messageOrdinal?: number }> = [];
		await store.iterateEntries({ type: "message", direction: "reverse", limit: 2 }, (entry, metadata) => {
			visited.push({ id: entry.id, messageOrdinal: metadata.messageOrdinal });
		});
		expect(visited).toEqual([
			{ id: "04", messageOrdinal: 2 },
			{ id: "03", messageOrdinal: 1 },
		]);
		store.close();
	});

	it("maintains cumulative usage and message counts across rebuild and append", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			{
				type: "message",
				id: "01",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
			assistant("02", "01", 10, 5),
		]);

		const store = IndexedJsonlSessionHistoryStore.open(path);
		store.append(assistant("03", "02", 20, 10));
		expect(store.getHistorySummary()).toEqual({
			entryCount: 3,
			compactionCount: 0,
			userMessages: 1,
			assistantMessages: 2,
			toolResults: 0,
			totalMessages: 3,
			toolCalls: 2,
			usage: { input: 30, output: 6, cacheRead: 15, cacheWrite: 4, cost: 0.5 },
			latestCacheHitRate: 31.25,
		});
		store.close();
	});

	it("counts every message role before and after persistence", () => {
		const root = createRoot();
		const manager = SessionManager.create(root, root, { id: "message-role-parity" });
		manager.appendMessage({
			role: "bashExecution",
			command: "true",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		expect(manager.getHistorySummary().totalMessages).toBe(1);
		manager.flush();
		expect(manager.getHistorySummary().totalMessages).toBe(1);
		manager.close();
	});

	it("keeps append and message ordinals stable across persistence", () => {
		const root = createRoot();
		const manager = SessionManager.create(root, root, { id: "metadata-parity" });
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const customId = manager.appendCustomEntry("marker");
		const abandonedId = manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
		manager.branch(customId);
		const leafId = manager.appendMessage({ role: "user", content: "selected", timestamp: 3 });
		const projection = () =>
			manager.getActiveBranchMetadata().map(({ id, ordinal, messageOrdinal }) => ({ id, ordinal, messageOrdinal }));
		const expected = [
			{ id: rootId, ordinal: 0, messageOrdinal: 0 },
			{ id: customId, ordinal: 1, messageOrdinal: undefined },
			{ id: leafId, ordinal: 3, messageOrdinal: 2 },
		];

		expect(projection()).toEqual(expected);
		expect(manager.getEntryMetadata(abandonedId)?.messageOrdinal).toBe(1);
		manager.flush();
		expect(projection()).toEqual(expected);
		expect(manager.getEntryMetadata(abandonedId)?.messageOrdinal).toBe(1);
		manager.close();
	});

	it("pages append-order history without hydrating the rest", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "one"), custom("02", "01", "two"), custom("03", "02", "three")]);
		const store = IndexedJsonlSessionHistoryStore.open(path, 1024);
		const first = store.getEntriesPage({ limit: 2 });
		expect(first.entries.map((entry) => entry.id)).toEqual(["01", "02"]);
		expect(first.nextOrdinal).toBe(1);
		const second = store.getEntriesPage({ afterOrdinal: first.nextOrdinal, limit: 2 });
		expect(second.entries.map((entry) => entry.id)).toEqual(["03"]);
		expect(second.nextOrdinal).toBeUndefined();
		store.close();
	});

	it("pages joined tree metadata without growing the hydration cache", async () => {
		const path = join(createRoot(), "session.jsonl");
		const labelTimestamp = "2026-01-01T00:02:00.000Z";
		writeSession(path, [
			header(),
			custom("01", null, { payload: "historical" }),
			custom("02", "01", { payload: "kept" }),
			compaction("03", "02", "02"),
			custom("04", "03", { payload: "tail" }),
			{
				type: "label",
				id: "05",
				parentId: "04",
				timestamp: labelTimestamp,
				targetId: "01",
				label: "old label",
			},
		]);

		const store = IndexedJsonlSessionHistoryStore.open(path, 1024);
		const before = store.getMetrics().session_hydration_cache_bytes;
		const page = store.getTreePage({ limit: 2 });
		expect(page.entries[0]).toMatchObject({
			ordinal: 0,
			id: "01",
			parentId: null,
			type: "custom",
			customType: "test",
			timestamp: expect.any(String),
			label: "old label",
			labelTimestamp,
			entryPreview: {
				id: "01",
				parentId: null,
				type: "custom",
				customType: "test",
			},
		});
		expect(page.entries[0]!.entryPreview).not.toHaveProperty("data");
		expect(page.nextOrdinal).toBe(1);
		expect(store.getMetrics().session_hydration_cache_bytes).toBe(before);
		store.close();

		const manager = SessionManager.open(path);
		const managerBefore = manager.getHistoryMetrics()!.session_hydration_cache_bytes;
		await expect(manager.getTreePage({ limit: 2 })).resolves.toEqual(page);
		expect(manager.getHistoryMetrics()!.session_hydration_cache_bytes).toBe(managerBefore);
		manager.close();
	});

	it("stores bounded UTF-8 tree previews without hydrating large message records", () => {
		const path = join(createRoot(), "large-tree-preview.jsonl");
		const fullContent = "🚀".repeat(2 * 1024 * 1024);
		writeSession(path, [header(), user("01", null, fullContent, 1)]);

		const store = IndexedJsonlSessionHistoryStore.open(path, 1024);
		const before = store.getMetrics().session_hydration_cache_bytes;
		const page = store.getTreePage({ limit: 1 });
		expect(page.entries).toHaveLength(1);
		const preview = page.entries[0]!.entryPreview;
		expect(preview).toMatchObject({ id: "01", type: "message", message: { role: "user" } });
		if (preview?.type !== "message" || preview.message.role !== "user") {
			throw new Error("expected a user-message tree preview");
		}
		const previewContent = preview.message.content;
		if (typeof previewContent !== "string") throw new Error("expected string preview content");
		expect(Buffer.byteLength(previewContent, "utf8")).toBeLessThanOrEqual(3072);
		expect(previewContent).toMatch(/…$/u);
		expect(store.getMetrics().session_hydration_cache_bytes).toBe(before);
		store.close();
	});

	it("flushes a new persisted session without rewriting it and closes idempotently", () => {
		const root = createRoot();
		const manager = SessionManager.create(root, root, { id: "durable-session" });
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.flush();
		const path = manager.getSessionFile();
		expect(path).toBeDefined();
		const before = sha256(path!);
		manager.flush();
		expect(sha256(path!)).toBe(before);
		manager.close();
		manager.close();
		expect(() => manager.flush()).toThrow();
		expect(sha256(path!)).toBe(before);

		const reopened = SessionManager.open(path!);
		expect(reopened.getEntries()).toHaveLength(1);
		reopened.close();
	});

	it("streams a current-version fork while preserving source and body bytes", () => {
		const root = createRoot();
		const path = join(root, "source.jsonl");
		const first = user("01", null, "first", 1);
		const second = user("02", "01", "second", 2);
		writeFileSync(
			path,
			`${JSON.stringify(header())}\n${JSON.stringify(first)}\nmalformed-middle\n${JSON.stringify(second)}`,
		);
		const before = sha256(path);
		const sourceBody = readFileSync(path, "utf8").split("\n").slice(1).join("\n");

		const forked = SessionManager.forkFrom(path, root, root, { id: "forked-session" });
		const forkedPath = forked.getSessionFile()!;
		expect(
			forked
				.buildSessionContext()
				.messages.map((message) => (message.role === "user" ? message.content : undefined)),
		).toEqual(["first", "second"]);
		expect(readFileSync(forkedPath, "utf8").split("\n").slice(1).join("\n")).toBe(sourceBody);
		expect(sha256(path)).toBe(before);
		forked.close();
	});

	it("fails before mutation when a deferred branch exceeds its memory bound", () => {
		const root = createRoot();
		const path = join(root, "source.jsonl");
		const entries: FileEntry[] = [header()];
		let parentId: string | null = null;
		for (let index = 0; index < 8193; index++) {
			const id = `entry-${index}`;
			entries.push(custom(id, parentId, index));
			parentId = id;
		}
		writeSession(path, entries);
		const manager = SessionManager.open(path, root);
		const beforeHash = sha256(path);
		const beforeLeaf = manager.getLeafId();

		expect(() => manager.createBranchedSession(parentId!)).toThrow("Cannot defer branched session");
		expect(manager.getSessionFile()).toBe(path);
		expect(manager.getLeafId()).toBe(beforeLeaf);
		expect(sha256(path)).toBe(beforeHash);
		expect(readdirSync(root).filter((name) => name.includes(".branch.") || name.endsWith(".jsonl.tmp"))).toEqual([]);
		manager.close();
	}, 30_000);

	it("serializes appends from independent live stores", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const first = IndexedJsonlSessionHistoryStore.open(path);
		const second = IndexedJsonlSessionHistoryStore.open(path);
		first.append(custom("02", "01", "from-first"));
		second.append(custom("03", "02", "from-second"));
		expect(first.getEntry("03")).toMatchObject({ id: "03", parentId: "02" });
		expect(second.getHistorySummary().entryCount).toBe(3);
		first.close();
		second.close();
	});

	it("converges symlink aliases on one source lock and sidecar", () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const alias = join(root, "alias.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		symlinkSync(path, alias);

		const canonicalStore = IndexedJsonlSessionHistoryStore.open(path);
		const aliasStore = IndexedJsonlSessionHistoryStore.open(alias);
		expect(aliasStore.indexPath).toBe(canonicalStore.indexPath);
		canonicalStore.append(custom("02", "01", "canonical"));
		aliasStore.append(custom("03", "02", "alias"));
		expect(canonicalStore.getEntry("03")).toMatchObject({ parentId: "02" });
		canonicalStore.close();
		aliasStore.close();
	});

	it("rejects hard-linked session aliases", () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const alias = join(root, "hardlink.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		linkSync(path, alias);
		expect(() => IndexedJsonlSessionHistoryStore.open(alias)).toThrow("Hard-linked session files are not supported");
	});

	it("never treats sibling lock-like paths as disposable", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [header(), custom("01", null, "first")]);
		const lockPath = `${path}.lock`;
		const reaperPath = `${lockPath}.reaper`;
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "sentinel"), "keep-lock");
		writeFileSync(reaperPath, "keep-reaper");

		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getEntry("01")).toBeDefined();
		expect(readFileSync(join(lockPath, "sentinel"), "utf8")).toBe("keep-lock");
		expect(readFileSync(reaperPath, "utf8")).toBe("keep-reaper");
		store.close();
	});

	it("atomically initializes and serializes source locks across processes with different TMPDIR values", async () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const partialPath = join(root, "partial");
		const attemptPath = join(root, "attempt");
		const releasePath = join(root, "release");
		const holderPath = join(root, "lock-holder.ts");
		const waiterPath = join(root, "lock-waiter.ts");
		const firstTmp = join(root, "tmp-first");
		const secondTmp = join(root, "tmp-second");
		mkdirSync(firstTmp);
		mkdirSync(secondTmp);
		writeSession(path, [header()]);
		const storeUrl = JSON.stringify(new URL("../../src/core/session-history-store.ts", import.meta.url).href);
		const sqliteUrl = JSON.stringify(new URL("../../src/core/sqlite.ts", import.meta.url).href);
		writeFileSync(
			holderPath,
			`import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from ${sqliteUrl};
const [path, partialPath, attemptPath, releasePath] = process.argv.slice(2);
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(this: InstanceType<typeof DatabaseSync>, sql: string) {
  if (sql.startsWith("PRAGMA application_id = ")) {
    originalExec.call(this, "CREATE TABLE IF NOT EXISTS source_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))");
    writeFileSync(partialPath, "partial");
    process.stdout.write("partial\\n");
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(attemptPath)) Atomics.wait(waiter, 0, 0, 5);
    Atomics.wait(waiter, 0, 0, 100);
  }
  originalExec.call(this, sql);
};
const { acquireSourceLock } = await import(${storeUrl});
const release = acquireSourceLock(path);
process.stdout.write("locked\\n");
const waiter = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 5);
release();
process.stdout.write("released\\n");
`,
		);
		writeFileSync(
			waiterPath,
			`import { writeFileSync } from "node:fs";
import { acquireSourceLock } from ${storeUrl};
const [path, attemptPath] = process.argv.slice(2);
writeFileSync(attemptPath, "attempt");
process.stdout.write("attempting\\n");
const release = acquireSourceLock(path);
process.stdout.write("acquired\\n");
release();
`,
		);
		const launch = (workerPath: string, args: string[], tmp: string) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, ...args], {
				env: { ...process.env, TMPDIR: tmp },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const waitFor = (marker: string) =>
				new Promise<void>((resolve, reject) => {
					const inspect = () => {
						if (stdout.includes(marker)) resolve();
					};
					child.stdout.on("data", inspect);
					child.once("error", reject);
					child.once("exit", (code) => {
						inspect();
						if (!stdout.includes(marker)) reject(new Error(`worker exited ${code}: ${stderr}`));
					});
				});
			const done = new Promise<void>((resolve, reject) => {
				child.once("exit", (code) =>
					code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)),
				);
				child.once("error", reject);
			});
			return { waitFor, done, output: () => stdout };
		};

		const holder = launch(holderPath, [path, partialPath, attemptPath, releasePath], firstTmp);
		await holder.waitFor("partial");
		const waiter = launch(waiterPath, [path, attemptPath], secondTmp);
		const completed = Promise.allSettled([holder.done, waiter.done]);
		await waiter.waitFor("attempting");
		await holder.waitFor("locked");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(waiter.output()).not.toContain("acquired");
		writeFileSync(releasePath, "release");
		const results = await completed;
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
		expect(waiter.output()).toContain("acquired");
	}, 30_000);

	it("releases the source lock when its process exits", async () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const workerPath = join(root, "abandon-lock.ts");
		writeSession(path, [header()]);
		writeFileSync(
			workerPath,
			`import { acquireSourceLock } from ${JSON.stringify(new URL("../../src/core/session-history-store.ts", import.meta.url).href)};
acquireSourceLock(process.argv[2]);
process.stdout.write("locked\\n");
`,
		);
		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, path], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
			child.once("error", reject);
		});

		const release = acquireSourceLock(path);
		release();
	});

	it("serializes simultaneous appends from independent processes", async () => {
		const root = createRoot();
		const path = join(root, "session.jsonl");
		const startPath = join(root, "start");
		const workerPath = join(root, "append-worker.ts");
		writeSession(path, [header()]);
		writeFileSync(
			workerPath,
			`import { existsSync } from "node:fs";
import { IndexedJsonlSessionHistoryStore } from ${JSON.stringify(new URL("../../src/core/session-history-store.ts", import.meta.url).href)};
const [path, startPath, prefix] = process.argv.slice(2);
const waiter = new Int32Array(new SharedArrayBuffer(4));
const store = IndexedJsonlSessionHistoryStore.open(path);
process.stdout.write("ready\\n");
while (!existsSync(startPath)) Atomics.wait(waiter, 0, 0, 5);
for (let index = 0; index < 25; index++) {
  store.append({
    type: "custom",
	    id: prefix + "-" + index,
    parentId: null,
    timestamp: new Date(index).toISOString(),
    customType: "concurrency",
    data: index,
  });
}
store.close();
`,
		);

		const launch = (prefix: string) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, path, startPath, prefix], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.once("data", (chunk) => {
					if (chunk.toString().includes("ready")) resolve();
					else reject(new Error(`worker did not become ready: ${chunk.toString()}`));
				});
				child.once("error", reject);
			});
			const done = new Promise<void>((resolve, reject) => {
				child.once("exit", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`worker exited ${code}: ${stderr}`));
				});
				child.once("error", reject);
			});
			return { ready, done };
		};

		const first = launch("first");
		const second = launch("second");
		await Promise.all([first.ready, second.ready]);
		writeFileSync(startPath, "start");
		await Promise.all([first.done, second.done]);

		const store = IndexedJsonlSessionHistoryStore.open(path);
		expect(store.getHistorySummary().entryCount).toBe(50);
		expect(new Set(store.getEntries().map((entry) => entry.id)).size).toBe(50);
		store.close();
	}, 30_000);

	it("keeps historical hydration within its byte budget after repeated compactions", () => {
		const path = join(createRoot(), "session.jsonl");
		const entries: FileEntry[] = [header()];
		let parentId: string | null = null;
		for (let cycle = 0; cycle < 40; cycle++) {
			let keptId = "";
			for (let turn = 0; turn < 25; turn++) {
				const id = `e-${cycle}-${turn}`;
				entries.push(custom(id, parentId, "x".repeat(4096)));
				parentId = id;
				keptId = id;
			}
			const id = `c-${cycle}`;
			entries.push(compaction(id, parentId!, keptId));
			parentId = id;
		}
		writeSession(path, entries);

		const cacheBudget = 32 * 1024;
		const store = IndexedJsonlSessionHistoryStore.open(path, cacheBudget);
		for (let cycle = 0; cycle < 40; cycle++) {
			expect(store.getEntry(`e-${cycle}-0`)).toBeDefined();
		}
		const metrics = store.getMetrics();
		expect(metrics.session_history_bytes).toBeGreaterThan(4 * 1024 * 1024);
		expect(metrics.session_active_entries).toBe(2);
		expect(metrics.session_hydration_cache_bytes).toBeLessThanOrEqual(cacheBudget);
		store.close();
	});

	it("returns an append-ordered detached compatibility tree", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			{ ...custom("orphan-a", "missing-a", { value: "a" }), timestamp: "2026-01-01T00:00:05.000Z" },
			{ ...custom("root", null, { value: "root" }), timestamp: "2026-01-01T00:00:04.000Z" },
			{ ...custom("child-new", "root", { value: "new" }), timestamp: "2026-01-01T00:00:03.000Z" },
			{ ...custom("child-old", "root", { value: "old" }), timestamp: "2026-01-01T00:00:02.000Z" },
			{ ...custom("orphan-b", "missing-b", { value: "b" }), timestamp: "2026-01-01T00:00:01.000Z" },
		]);

		const manager = SessionManager.open(path);
		const tree = manager.getTree();
		expect(tree.map((node) => node.entry.id)).toEqual(["orphan-a", "root", "orphan-b"]);
		expect(tree[1]!.children.map((node) => node.entry.id)).toEqual(["child-old", "child-new"]);
		manager.close();

		expect(JSON.parse(JSON.stringify(tree))).toMatchObject([
			{ entry: { id: "orphan-a", data: { value: "a" } } },
			{
				entry: { id: "root", data: { value: "root" } },
				children: [
					{ entry: { id: "child-old", data: { value: "old" } } },
					{ entry: { id: "child-new", data: { value: "new" } } },
				],
			},
			{ entry: { id: "orphan-b", data: { value: "b" } } },
		]);
	});

	it("defers a large linear context, materializes real arrays, and bounds it after compaction", async () => {
		const path = join(createRoot(), "session.jsonl");
		const entries: FileEntry[] = [header()];
		const expectedHash = createHash("sha256");
		let parentId: string | null = null;
		for (let index = 0; index < 9000; index++) {
			const id = `message-${index}`;
			const entry = user(id, parentId, `content-${index}`, index);
			entries.push(entry);
			expectedHash.update(JSON.stringify(entry.message));
			expectedHash.update("\n");
			parentId = id;
		}
		writeSession(path, entries);

		const manager = SessionManager.open(path);
		const source = manager.buildSessionContextSource().messages;
		expect(source.length).toBe(9000);
		expect(source.last()).toMatchObject({ role: "user", content: "content-8999" });
		expect(source.last("assistant")).toBeUndefined();
		const newest: string[] = [];
		for (const message of source.iterateReverse()) {
			if (message.role === "user") newest.push(message.content as string);
			if (newest.length === 3) break;
		}
		expect(newest).toEqual(["content-8999", "content-8998", "content-8997"]);
		const sourceCacheBytes = manager.getHistoryMetrics()!.session_hydration_cache_bytes;
		expect(sourceCacheBytes).toBeLessThanOrEqual(1024 * 1024);
		let lineageEntries = 0;
		await manager.iterateActiveAncestry((metadata) => {
			const entry = manager.getEntry(metadata.id);
			expect(entry).toBe(manager.getEntry(metadata.id));
			if (lineageEntries === 0) expect(entry?.id).toBe("message-8999");
			lineageEntries++;
		});
		expect(lineageEntries).toBe(9000);
		expect(manager.getHistoryMetrics()!.session_hydration_cache_bytes).toBe(sourceCacheBytes);

		const roots = manager.getTree();
		expect(roots).toHaveLength(1);
		const stack = [...roots];
		let treeEntries = 0;
		while (stack.length > 0) {
			const node = stack.pop()!;
			expect(node.entry.id).toBe(`message-${treeEntries}`);
			treeEntries++;
			stack.push(...node.children);
		}
		expect(treeEntries).toBe(9000);
		expect(manager.getHistoryMetrics()!.session_hydration_cache_bytes).toBe(sourceCacheBytes);
		expect(JSON.parse(JSON.stringify(roots[0].entry))).toMatchObject({
			id: "message-0",
			type: "message",
		});
		expect(manager.getHistoryMetrics()!.session_hydration_cache_bytes).toBe(sourceCacheBytes);

		const messages = manager.buildSessionContext().messages;
		expect(Array.isArray(messages)).toBe(true);
		expect(() => structuredClone(messages)).not.toThrow();
		expect(messages).toHaveLength(9000);
		expect(messages.at(0)).toMatchObject({ role: "user", content: "content-0" });
		expect(messages.at(-1)).toMatchObject({ role: "user", content: "content-8999" });
		expect(messages.slice(-3).map((message) => (message.role === "user" ? message.content : undefined))).toEqual([
			"content-8997",
			"content-8998",
			"content-8999",
		]);
		expect(Object.keys(messages.slice(0, 3))).toEqual(["0", "1", "2"]);
		const firstMessage = messages[0];
		expect(messages[0]).toBe(firstMessage);
		expect([...messages][0]).toBe(firstMessage);
		expect(messages.indexOf(firstMessage)).toBe(0);
		expect(messages.includes(firstMessage)).toBe(true);
		expect(messages.slice(0, 1)[0]).toBe(firstMessage);
		expect(delete messages[0]).toBe(true);
		expect(0 in messages).toBe(false);
		messages[0] = firstMessage;
		expect(messages[0]).toBe(firstMessage);

		const actualHash = createHash("sha256");
		for (const message of messages) {
			actualHash.update(JSON.stringify(message));
			actualHash.update("\n");
		}
		expect(actualHash.digest("hex")).toBe(expectedHash.digest("hex"));
		expect(manager.getHistoryMetrics()).toMatchObject({
			session_index_entries: 9000,
			session_active_entries: 9000,
		});
		expect(manager.getHistoryMetrics()!.session_hydration_cache_bytes).toBeLessThanOrEqual(1024 * 1024);

		const appended = { role: "user" as const, content: "appended", timestamp: 9001 };
		expect(messages.push(appended)).toBe(9001);
		expect(messages.at(-1)).toEqual(appended);
		expect(messages.pop()).toEqual(appended);
		expect(messages).toHaveLength(9000);

		manager.appendCompaction("summary", parentId!, 100_000);
		expect(source.length).toBe(9000);
		const compacted = manager.buildSessionContext().messages;
		expect(compacted).toHaveLength(2);
		expect(compacted[1]).toMatchObject({ role: "user", content: "content-8999" });
		expect(manager.getHistoryMetrics()).toMatchObject({
			session_index_entries: 9001,
			session_active_entries: 2,
		});
		expect(manager.getHistoryMetrics()!.session_active_payload_bytes).toBeLessThan(4096);
		expect(manager.getHistoryMetrics()!.session_hydration_cache_bytes).toBeLessThanOrEqual(1024 * 1024);
		manager.close();
		expect(messages.at(-1)).toMatchObject({ role: "user", content: "content-8999" });
	});

	it("normalizes legacy null content above the lazy-projection threshold", () => {
		const path = join(createRoot(), "session.jsonl");
		const entries: FileEntry[] = [header()];
		let parentId: string | null = null;
		for (let index = 0; index < 8193; index++) {
			const id = `message-${index}`;
			const role = index === 1 ? "assistant" : index === 2 ? "toolResult" : "user";
			entries.push({
				type: "message",
				id,
				parentId,
				timestamp: new Date(index).toISOString(),
				message: { role, content: null, timestamp: index },
			} as unknown as FileEntry);
			parentId = id;
		}
		writeSession(path, entries);

		const manager = SessionManager.open(path);
		const messages = manager.buildSessionContext().messages;
		expect(messages).toHaveLength(8193);
		expect(messages[0]).toMatchObject({ role: "user", content: [] });
		expect(messages[1]).toMatchObject({ role: "assistant", content: [] });
		expect(messages[2]).toMatchObject({ role: "toolResult", content: [] });
		manager.close();
	});

	it("retains indexed custom-message null content and normalizes its context projection", () => {
		const path = join(createRoot(), "session.jsonl");
		writeSession(path, [
			header(),
			{
				type: "custom_message",
				id: "01",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				customType: "legacy-null",
				content: null,
				display: true,
			} as unknown as FileEntry,
		]);

		const manager = SessionManager.open(path);
		expect((manager.getEntry("01") as unknown as { content: unknown }).content).toBeNull();
		expect(manager.buildSessionContext().messages[0]).toMatchObject({
			role: "custom",
			customType: "legacy-null",
			content: [],
		});
		manager.close();
	});
});
