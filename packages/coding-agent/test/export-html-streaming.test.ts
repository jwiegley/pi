import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	exportFromFile,
	exportSessionToHtml,
	generateHtml,
	type ToolHtmlRenderer,
} from "../src/core/export-html/index.ts";
import { type FileEntry, type SessionEntry, type SessionHeader, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-export-streaming-"));
	roots.push(root);
	return root;
}

function header(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "streaming-export",
		timestamp: "2026-08-06T12:00:00.000Z",
		cwd: "/tmp/project",
	};
}

function customEntry(id: string, parentId: string | null, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-08-06T12:00:01.000Z",
		customType: "export-test",
		data,
	};
}

function customToolCallEntry(index: number, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id: `call-entry-${index}`,
		parentId,
		timestamp: "2026-08-06T12:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${index}`, name: "custom-tool", arguments: { index } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: index * 2,
		},
	};
}

function customToolResultEntry(index: number): SessionEntry {
	return {
		type: "message",
		id: `result-entry-${index}`,
		parentId: `call-entry-${index}`,
		timestamp: "2026-08-06T12:00:02.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "custom-tool",
			content: [{ type: "text", text: `result-${index}` }],
			isError: false,
			timestamp: index * 2 + 1,
		},
	};
}

function writeSession(path: string, entries: Iterable<FileEntry>): void {
	const fd = openSync(path, "w");
	try {
		for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
	} finally {
		closeSync(fd);
	}
}

function readSessionData(path: string): { base64: string; data: Record<string, unknown> } {
	const html = readFileSync(path, "utf8");
	const prefix = '<script id="session-data" type="application/json">';
	const start = html.indexOf(prefix);
	const end = html.indexOf("</script>", start + prefix.length);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const base64 = html.slice(start + prefix.length, end);
	return { base64, data: JSON.parse(Buffer.from(base64, "base64").toString("utf8")) };
}

function expectNoExportTemps(root: string): void {
	expect(readdirSync(root).filter((name) => name.startsWith(".pi-export-"))).toEqual([]);
}

function processToolSpools(): string[] {
	const prefix = `pi-export-tools-${process.pid}-`;
	return readdirSync(tmpdir())
		.filter((name) => name.startsWith(prefix))
		.sort();
}

describe("streaming HTML export", () => {
	it("matches the legacy small-session HTML across UTF-8 and base64 boundaries", async () => {
		const root = createRoot();
		const inputPath = join(root, "session.jsonl");
		const outputPath = join(root, "session.html");
		const sessionHeader = header();
		const boundaryProbe = customEntry("02", "01", "");
		const insertionIndex = JSON.stringify(boundaryProbe).lastIndexOf('""') + 1;
		const boundaryValue = `${"a".repeat(16 * 1024 - 1 - insertionIndex)}😀suffix`;
		const boundaryEntry = customEntry("02", "01", boundaryValue);
		const boundaryJson = JSON.stringify(boundaryEntry);
		expect(boundaryJson.charCodeAt(16 * 1024 - 1)).toBe(0xd83d);
		expect(boundaryJson.charCodeAt(16 * 1024)).toBe(0xde00);
		const entries = [customEntry("01", null, "é"), boundaryEntry, customEntry("03", "02", "</script> & exact")];
		writeSession(inputPath, [sessionHeader, ...entries]);

		await exportFromFile(inputPath, { outputPath });

		const expectedData = { header: sessionHeader, entries, leafId: "03" };
		expect(readFileSync(outputPath, "utf8")).toBe(generateHtml(expectedData));
		const { base64 } = readSessionData(outputPath);
		expect(base64).toBe(Buffer.from(JSON.stringify(expectedData)).toString("base64"));
	});

	it("rejects the source session itself as the output before creating a temp file", async () => {
		const root = createRoot();
		const inputPath = join(root, "session.jsonl");
		writeSession(inputPath, [header(), customEntry("01", null, "unchanged")]);
		const original = readFileSync(inputPath);

		await expect(exportFromFile(inputPath, { outputPath: inputPath })).rejects.toThrow(
			"HTML export output must not overwrite its source session",
		);

		expect(readFileSync(inputPath)).toEqual(original);
		expectNoExportTemps(root);
	});

	it("exports a legacy session after its atomic open-time migration", async () => {
		const root = createRoot();
		const inputPath = join(root, "legacy.jsonl");
		const outputPath = join(root, "legacy.html");
		const legacyHeader = { ...header(), version: 2 } as SessionHeader;
		writeSession(inputPath, [legacyHeader, customEntry("legacy-entry", null, "preserved")]);

		await expect(exportFromFile(inputPath, { outputPath })).resolves.toBe(outputPath);

		const migratedHeader = JSON.parse(readFileSync(inputPath, "utf8").split("\n")[0]) as SessionHeader;
		expect(migratedHeader.version).toBe(3);
		const { data } = readSessionData(outputPath);
		expect((data.header as SessionHeader).version).toBe(3);
		expect((data.entries as SessionEntry[]).map((entry) => entry.id)).toEqual(["legacy-entry"]);
	});

	it("rejects a hard link to the source without changing either name", async () => {
		const root = createRoot();
		const inputPath = join(root, "session.jsonl");
		const outputPath = join(root, "session-hardlink.html");
		writeSession(inputPath, [header(), customEntry("01", null, "unchanged")]);
		linkSync(inputPath, outputPath);
		const original = readFileSync(inputPath);

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(
			"HTML export output must not overwrite its source session",
		);

		expect(readFileSync(inputPath)).toEqual(original);
		expect(readFileSync(outputPath)).toEqual(original);
		expectNoExportTemps(root);
	});

	it("rejects a symlink to the source without replacing the link", async () => {
		const root = createRoot();
		const inputPath = join(root, "session.jsonl");
		const outputPath = join(root, "session-symlink.html");
		writeSession(inputPath, [header(), customEntry("01", null, "unchanged")]);
		symlinkSync(inputPath, outputPath);
		const original = readFileSync(inputPath);

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(
			"HTML export output must not replace a symbolic-link destination",
		);

		expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(inputPath)).toEqual(original);
		expectNoExportTemps(root);
	});

	it("rejects export when an open manager's session symlink is retargeted", async () => {
		const root = createRoot();
		const firstPath = join(root, "first.jsonl");
		const secondPath = join(root, "second.jsonl");
		const activePath = join(root, "active.jsonl");
		const outputPath = join(root, "export.html");
		writeSession(firstPath, [header(), customEntry("first", null, "must remain JSONL")]);
		writeSession(secondPath, [header(), customEntry("second", null, "other session")]);
		symlinkSync(firstPath, activePath);
		const firstOriginal = readFileSync(firstPath);
		const secondOriginal = readFileSync(secondPath);
		const sm = SessionManager.open(activePath);
		unlinkSync(activePath);
		symlinkSync(secondPath, activePath);

		try {
			await expect(exportSessionToHtml(sm, undefined, { outputPath })).rejects.toThrow(
				"Cannot export because the session file changed after it was opened",
			);
		} finally {
			sm.close();
		}

		expect(readFileSync(firstPath)).toEqual(firstOriginal);
		expect(readFileSync(secondPath)).toEqual(secondOriginal);
		expectNoExportTemps(root);
	});

	it("rejects an equal-length in-place source edit made after the manager opened", async () => {
		const root = createRoot();
		const inputPath = join(root, "edited.jsonl");
		const outputPath = join(root, "edited.html");
		function* entries(): Iterable<FileEntry> {
			yield header();
			for (let index = 0; index < 9000; index++) {
				yield customEntry(
					`entry-${index}`,
					index === 0 ? null : `entry-${index - 1}`,
					index === 0 ? "AAAA" : index,
				);
			}
		}
		writeSession(inputPath, entries());
		const sm = SessionManager.open(inputPath);
		const originalStats = statSync(inputPath);
		const edited = readFileSync(inputPath, "utf8").replace('"data":"AAAA"', '"data":"BBBB"');
		writeFileSync(inputPath, edited);
		const editedStats = statSync(inputPath);

		try {
			await expect(exportSessionToHtml(sm, undefined, { outputPath })).rejects.toThrow(
				"Session JSONL changed outside the indexed writer",
			);
		} finally {
			sm.close();
		}

		expect(editedStats.dev).toBe(originalStats.dev);
		expect(editedStats.ino).toBe(originalStats.ino);
		expect(editedStats.size).toBe(originalStats.size);
		expect(existsSync(outputPath)).toBe(false);
		expectNoExportTemps(root);
	});

	it("rejects a source replacement interposed during standalone open", async () => {
		const root = createRoot();
		const inputPath = join(root, "requested.jsonl");
		const savedInputPath = join(root, "requested-original.jsonl");
		const replacementPath = join(root, "replacement.jsonl");
		const outputPath = join(root, "export.html");
		writeSession(inputPath, [header(), customEntry("requested", null, "requested session")]);
		writeSession(replacementPath, [header(), customEntry("replacement", null, "replacement session")]);
		const originalOpen = SessionManager.open.bind(SessionManager);
		vi.spyOn(SessionManager, "open").mockImplementation((path, sessionDir, cwdOverride) => {
			const sm = originalOpen(path, sessionDir, cwdOverride);
			renameSync(inputPath, savedInputPath);
			renameSync(replacementPath, inputPath);
			return sm;
		});

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(
			"Cannot export because the session file changed while it was opened",
		);

		expect(readFileSync(savedInputPath, "utf8")).toContain("requested session");
		expect(readFileSync(inputPath, "utf8")).toContain("replacement session");
		expect(existsSync(outputPath)).toBe(false);
		expectNoExportTemps(root);
	});

	it("resolves a symlinked parent when checking source aliases", async () => {
		const root = createRoot();
		const realDir = join(root, "real");
		const aliasDir = join(root, "alias");
		mkdirSync(realDir);
		symlinkSync(realDir, aliasDir);
		const inputPath = join(realDir, "session.jsonl");
		const aliasedOutputPath = join(aliasDir, "session.jsonl");
		writeSession(inputPath, [header(), customEntry("01", null, "unchanged")]);
		const original = readFileSync(inputPath);

		await expect(exportFromFile(inputPath, { outputPath: aliasedOutputPath })).rejects.toThrow(
			"HTML export output must not overwrite its source session",
		);

		expect(readFileSync(inputPath)).toEqual(original);
		expectNoExportTemps(realDir);
	});

	it("pins a symlinked output parent before asynchronous rendering", async () => {
		const root = createRoot();
		const originalDir = join(root, "original-output");
		const sourceDir = join(root, "source");
		const aliasDir = join(root, "output-alias");
		mkdirSync(originalDir);
		mkdirSync(sourceDir);
		symlinkSync(originalDir, aliasDir);
		const inputPath = join(sourceDir, "session.jsonl");
		const requestedOutputPath = join(aliasDir, "session.jsonl");
		const actualOutputPath = join(realpathSync(originalDir), "session.jsonl");
		writeSession(inputPath, [header(), customToolCallEntry(0, null)]);
		const original = readFileSync(inputPath);
		const sm = SessionManager.open(inputPath);
		let retargeted = false;
		const toolRenderer: ToolHtmlRenderer = {
			renderCall() {
				unlinkSync(aliasDir);
				symlinkSync(sourceDir, aliasDir);
				retargeted = true;
				return "<b>safe</b>";
			},
			renderResult: () => undefined,
		};

		try {
			await expect(
				exportSessionToHtml(sm, undefined, { outputPath: requestedOutputPath, toolRenderer }),
			).resolves.toBe(actualOutputPath);
		} finally {
			sm.close();
		}

		expect(retargeted).toBe(true);
		expect(readFileSync(inputPath)).toEqual(original);
		expect(readSessionData(actualOutputPath).data.leafId).toBe("call-entry-0");
		expectNoExportTemps(originalDir);
		expectNoExportTemps(sourceDir);
	});

	it("rejects an unrelated symbolic-link output instead of replacing the link", async () => {
		const root = createRoot();
		const inputPath = join(root, "session.jsonl");
		const existingPath = join(root, "existing.html");
		const outputPath = join(root, "linked-output.html");
		writeSession(inputPath, [header(), customEntry("01", null, "unchanged")]);
		writeFileSync(existingPath, "existing output");
		symlinkSync(existingPath, outputPath);

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(
			"HTML export output must not replace a symbolic-link destination",
		);

		expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(existingPath, "utf8")).toBe("existing output");
		expectNoExportTemps(root);
	});

	it("rejects an unrelated hard-linked output instead of breaking its link", async () => {
		const root = createRoot();
		const inputPath = join(root, "session.jsonl");
		const outputPath = join(root, "linked-output.html");
		const siblingPath = join(root, "linked-output-copy.html");
		writeSession(inputPath, [header(), customEntry("01", null, "unchanged")]);
		writeFileSync(outputPath, "existing output");
		linkSync(outputPath, siblingPath);

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(
			"HTML export output must not replace a hard-linked destination",
		);

		expect(readFileSync(outputPath, "utf8")).toBe("existing output");
		expect(readFileSync(siblingPath, "utf8")).toBe("existing output");
		expectNoExportTemps(root);
	});

	it("streams more than 4096 large entries without calling getEntries", async () => {
		const root = createRoot();
		const inputPath = join(root, "large-session.jsonl");
		const outputPath = join(root, "large-session.html");
		const payload = "x".repeat(2048);
		const entryCount = 5001;
		function* sessionEntries(): Iterable<FileEntry> {
			yield header();
			for (let index = 0; index < entryCount; index++) {
				yield customEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, payload);
			}
		}
		writeSession(inputPath, sessionEntries());
		const getEntries = vi.spyOn(SessionManager.prototype, "getEntries").mockImplementation(() => {
			throw new Error("getEntries must not be used by HTML export");
		});
		const iterateEntries = vi.spyOn(SessionManager.prototype, "iterateEntries");

		await exportFromFile(inputPath, { outputPath });

		expect(getEntries).not.toHaveBeenCalled();
		expect(iterateEntries).toHaveBeenCalledTimes(1);
		expect(iterateEntries).toHaveBeenCalledWith(
			{ direction: "forward", toOrdinal: entryCount - 1 },
			expect.any(Function),
		);
		expect(statSync(outputPath).size).toBeGreaterThan(statSync(inputPath).size);
		const { data } = readSessionData(outputPath);
		const exportedEntries = data.entries as SessionEntry[];
		expect(exportedEntries).toHaveLength(entryCount);
		expect(exportedEntries[0].id).toBe("entry-0");
		expect(exportedEntries.at(-1)?.id).toBe(`entry-${entryCount - 1}`);
	}, 30_000);

	it("exports under a heap smaller than the session without materializing the output", () => {
		const root = createRoot();
		const inputPath = join(root, "larger-than-heap.jsonl");
		const outputPath = join(root, "larger-than-heap.html");
		const runnerPath = join(root, "export-runner.mjs");
		const payload = "x".repeat(4096);
		function* sessionEntries(): Iterable<FileEntry> {
			yield header();
			for (let index = 0; index < 20_000; index++) {
				yield customEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, payload);
			}
		}
		writeSession(inputPath, sessionEntries());
		writeFileSync(
			runnerPath,
			`import { exportFromFile } from ${JSON.stringify(new URL("../src/core/export-html/index.ts", import.meta.url).href)};\n` +
				"await exportFromFile(process.argv[2], { outputPath: process.argv[3] });\n",
		);

		const result = spawnSync(
			process.execPath,
			["--max-old-space-size=64", "--experimental-strip-types", runnerPath, inputPath, outputPath],
			{ encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
		);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(statSync(inputPath).size).toBeGreaterThan(64 * 1024 * 1024);
		expect(statSync(outputPath).size).toBeGreaterThan(statSync(inputPath).size);
		expectNoExportTemps(root);
	}, 130_000);

	it("uses an explicit render pass and preserves custom tool HTML", async () => {
		const root = createRoot();
		const inputPath = join(root, "tools.jsonl");
		const outputPath = join(root, "tools.html");
		const sessionHeader = header();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "01",
				parentId: null,
				timestamp: "2026-08-06T12:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "custom-tool", arguments: { value: 1 } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "02",
				parentId: "01",
				timestamp: "2026-08-06T12:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "custom-tool",
					content: [{ type: "text", text: "result" }],
					details: { exact: true },
					isError: false,
					timestamp: 2,
				},
			},
		];
		writeSession(inputPath, [sessionHeader, ...entries]);
		const sm = SessionManager.open(inputPath);
		const iterateEntries = vi.spyOn(sm, "iterateEntries");
		vi.spyOn(sm, "getEntries").mockImplementation(() => {
			throw new Error("getEntries must not be used by HTML export");
		});
		const toolRenderer: ToolHtmlRenderer = {
			renderCall: vi.fn(() => "<b>call</b>"),
			renderResult: vi.fn(() => ({ collapsed: "<i>short</i>", expanded: "<i>long</i>" })),
		};

		try {
			await exportSessionToHtml(sm, undefined, { outputPath, toolRenderer });
		} finally {
			sm.close();
		}

		expect(iterateEntries).toHaveBeenCalledTimes(2);
		expect(toolRenderer.renderCall).toHaveBeenCalledWith("call-1", "custom-tool", { value: 1 });
		expect(toolRenderer.renderResult).toHaveBeenCalledWith(
			"call-1",
			"custom-tool",
			[{ type: "text", text: "result" }],
			{ exact: true },
			false,
		);
		const { data } = readSessionData(outputPath);
		expect(data.renderedTools).toEqual({
			"call-1": {
				callHtml: "<b>call</b>",
				resultHtmlCollapsed: "<i>short</i>",
				resultHtmlExpanded: "<i>long</i>",
			},
		});
		expect(readFileSync(outputPath, "utf8")).toBe(
			generateHtml({
				header: sessionHeader,
				entries,
				leafId: "02",
				renderedTools: data.renderedTools as Record<
					string,
					{ callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }
				>,
			}),
		);
	});

	it("uses one captured history boundary for render and write passes", async () => {
		const root = createRoot();
		const inputPath = join(root, "snapshot.jsonl");
		const outputPath = join(root, "snapshot.html");
		const originalEntry = customToolCallEntry(0, null);
		writeSession(inputPath, [header(), originalEntry]);
		const sm = SessionManager.open(inputPath);
		const originalIterate = sm.iterateEntries.bind(sm);
		let completedPasses = 0;
		const iterateEntries = vi.spyOn(sm, "iterateEntries").mockImplementation(async (options, visitor) => {
			await originalIterate(options, visitor);
			completedPasses++;
			if (completedPasses === 1) sm.appendCustomEntry("after-export-snapshot", { excluded: true });
		});
		const toolRenderer: ToolHtmlRenderer = {
			renderCall: () => "<b>call</b>",
			renderResult: () => undefined,
		};

		try {
			await exportSessionToHtml(sm, undefined, { outputPath, toolRenderer });
		} finally {
			sm.close();
		}

		expect(iterateEntries).toHaveBeenNthCalledWith(1, { direction: "forward", toOrdinal: 0 }, expect.any(Function));
		expect(iterateEntries).toHaveBeenNthCalledWith(2, { direction: "forward", toOrdinal: 0 }, expect.any(Function));
		const { data } = readSessionData(outputPath);
		expect(data.entries).toEqual([originalEntry]);
		expect(data.leafId).toBe(originalEntry.id);
	});

	it("rejects an equal-length source edit between the render and write passes", async () => {
		const root = createRoot();
		const inputPath = join(root, "edited-between-passes.jsonl");
		const outputPath = join(root, "edited-between-passes.html");
		writeSession(inputPath, [header(), customEntry("payload", null, "AAAA"), customToolCallEntry(0, "payload")]);
		const sm = SessionManager.open(inputPath);
		const originalIterate = sm.iterateEntries.bind(sm);
		let completedPasses = 0;
		vi.spyOn(sm, "iterateEntries").mockImplementation(async (options, visitor) => {
			await originalIterate(options, visitor);
			completedPasses++;
			if (completedPasses === 1) {
				const edited = readFileSync(inputPath, "utf8").replace('"data":"AAAA"', '"data":"BBBB"');
				writeFileSync(inputPath, edited);
			}
		});
		const toolRenderer: ToolHtmlRenderer = {
			renderCall: () => "<b>call</b>",
			renderResult: () => undefined,
		};

		try {
			await expect(exportSessionToHtml(sm, undefined, { outputPath, toolRenderer })).rejects.toThrow(
				"Session JSONL changed while exporting",
			);
		} finally {
			sm.close();
		}

		expect(completedPasses).toBe(2);
		expect(existsSync(outputPath)).toBe(false);
		expectNoExportTemps(root);
	});

	it("spools more than 4096 custom tool renders to disk and removes the spool", async () => {
		const root = createRoot();
		const inputPath = join(root, "many-tools.jsonl");
		const outputPath = join(root, "many-tools.html");
		const toolCount = 5001;
		function* sessionEntries(): Iterable<FileEntry> {
			yield header();
			let parentId: string | null = null;
			for (let index = 0; index < toolCount; index++) {
				yield customToolCallEntry(index, parentId);
				yield customToolResultEntry(index);
				parentId = `result-entry-${index}`;
			}
		}
		writeSession(inputPath, sessionEntries());
		const sm = SessionManager.open(inputPath);
		const spoolsBefore = processToolSpools();
		vi.spyOn(sm, "getEntries").mockImplementation(() => {
			throw new Error("getEntries must not be used by HTML export");
		});
		let callsRendered = 0;
		let resultsRendered = 0;
		let sawDiskSpool = false;
		const toolRenderer: ToolHtmlRenderer = {
			renderCall(toolCallId) {
				callsRendered++;
				sawDiskSpool ||= processToolSpools().some((name) => !spoolsBefore.includes(name));
				return `<b>${toolCallId}</b>`;
			},
			renderResult(toolCallId) {
				resultsRendered++;
				return { expanded: `<i>${toolCallId}</i>` };
			},
		};

		try {
			await exportSessionToHtml(sm, undefined, { outputPath, toolRenderer });
		} finally {
			sm.close();
		}

		expect(sawDiskSpool).toBe(true);
		expect(processToolSpools()).toEqual(spoolsBefore);
		expect(callsRendered).toBe(toolCount);
		expect(resultsRendered).toBe(toolCount);
		expectNoExportTemps(root);
		const { data } = readSessionData(outputPath);
		const renderedTools = data.renderedTools as Record<string, unknown>;
		expect(Object.keys(renderedTools)).toHaveLength(toolCount);
		expect(renderedTools["call-0"]).toEqual({
			callHtml: "<b>call-0</b>",
			resultHtmlExpanded: "<i>call-0</i>",
		});
		expect(renderedTools[`call-${toolCount - 1}`]).toEqual({
			callHtml: `<b>call-${toolCount - 1}</b>`,
			resultHtmlExpanded: `<i>call-${toolCount - 1}</i>`,
		});
	}, 30_000);
});
