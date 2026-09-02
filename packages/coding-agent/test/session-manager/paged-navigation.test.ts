import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "../utilities.ts";

interface TestManager {
	readonly manager: SessionManager;
	reopen(): SessionManager;
	cleanup(): void;
}

const managerFactories: Array<[string, () => TestManager]> = [
	[
		"in memory",
		() => ({
			manager: SessionManager.inMemory(),
			reopen() {
				return this.manager;
			},
			cleanup() {},
		}),
	],
	[
		"persisted",
		() => {
			const root = mkdtempSync(join(tmpdir(), "pi-paged-navigation-"));
			let manager = SessionManager.create(root, root);
			return {
				get manager() {
					return manager;
				},
				reopen() {
					manager.flush();
					const sessionFile = manager.getSessionFile();
					if (!sessionFile) throw new Error("Persisted test session has no file");
					manager.close();
					manager = SessionManager.open(sessionFile, root, root);
					return manager;
				},
				cleanup() {
					manager.close();
					rmSync(root, { recursive: true, force: true });
				},
			};
		},
	],
];

function appendEntries(manager: SessionManager): string[] {
	return Array.from({ length: 5 }, (_, index) => manager.appendCustomEntry("page-test", { index }));
}

describe.each(managerFactories)("SessionManager.getTreePage (%s)", (_name, createManager) => {
	it("uses an exclusive forward cursor and reports the last returned ordinal only when more entries remain", async () => {
		const fixture = createManager();
		let manager = fixture.manager;
		try {
			const ids = appendEntries(manager);
			manager = fixture.reopen();

			const first = await manager.getTreePage({ direction: "forward", limit: 2 });
			expect(first.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[0, ids[0]],
				[1, ids[1]],
			]);
			expect(first.entries[0]).not.toHaveProperty("entry");
			expect(first.entries[0]).not.toHaveProperty("data");
			expect(first.nextOrdinal).toBe(1);

			const second = await manager.getTreePage({
				afterOrdinal: first.nextOrdinal ?? undefined,
				direction: "forward",
				limit: 2,
			});
			expect(second.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[2, ids[2]],
				[3, ids[3]],
			]);
			expect(second.nextOrdinal).toBe(3);

			const last = await manager.getTreePage({
				afterOrdinal: second.nextOrdinal ?? undefined,
				direction: "forward",
				limit: 2,
			});
			expect(last.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([[4, ids[4]]]);
			expect(last.nextOrdinal).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it("returns reverse pages oldest-to-newest while the oldest ordinal remains the exclusive cursor", async () => {
		const fixture = createManager();
		let manager = fixture.manager;
		try {
			const ids = appendEntries(manager);
			manager = fixture.reopen();

			const first = await manager.getTreePage({ direction: "reverse", limit: 2 });
			expect(first.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[3, ids[3]],
				[4, ids[4]],
			]);
			expect(first.nextOrdinal).toBe(3);

			const second = await manager.getTreePage({
				beforeOrdinal: first.nextOrdinal ?? undefined,
				direction: "reverse",
				limit: 2,
			});
			expect(second.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[1, ids[1]],
				[2, ids[2]],
			]);
			expect(second.nextOrdinal).toBe(1);

			const last = await manager.getTreePage({
				beforeOrdinal: second.nextOrdinal ?? undefined,
				direction: "reverse",
				limit: 2,
			});
			expect(last.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([[0, ids[0]]]);
			expect(last.nextOrdinal).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it("pages across filtered ordinal gaps without hydrating indexed payloads", async () => {
		const fixture = createManager();
		let manager = fixture.manager;
		try {
			const firstId = manager.appendCustomEntry("wanted", { payload: "first" });
			manager.appendCustomEntry("gap", { payload: "ignored" });
			const secondId = manager.appendCustomEntry("wanted", { payload: "second" });
			manager.appendCustomEntry("gap", { payload: "ignored" });
			const thirdId = manager.appendCustomEntry("wanted", { payload: "third" });
			manager.appendLabelChange(secondId, "middle");
			manager = fixture.reopen();

			const beforeCache = manager.getHistoryMetrics()?.session_hydration_cache_bytes;
			const first = await manager.getTreePage({ customType: "wanted", direction: "forward", limit: 2 });
			expect(first.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[0, firstId],
				[2, secondId],
			]);
			expect(first.entries[1]).toMatchObject({ label: "middle" });
			expect(first.nextOrdinal).toBe(2);
			const last = await manager.getTreePage({
				afterOrdinal: first.nextOrdinal ?? undefined,
				customType: "wanted",
				direction: "forward",
				limit: 2,
			});
			expect(last.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([[4, thirdId]]);
			expect(last.nextOrdinal).toBeNull();
			expect(manager.getHistoryMetrics()?.session_hydration_cache_bytes).toBe(beforeCache);
		} finally {
			fixture.cleanup();
		}
	});

	it("applies type and message-role filters before forward and reverse limits", async () => {
		const fixture = createManager();
		let manager = fixture.manager;
		try {
			const firstId = manager.appendMessage(userMsg("first"));
			manager.appendMessage(assistantMsg("gap"));
			manager.appendCustomEntry("gap");
			const secondId = manager.appendMessage(userMsg("second"));
			manager.appendMessage(assistantMsg("gap"));
			const thirdId = manager.appendMessage(userMsg("third"));
			manager = fixture.reopen();

			const forward = await manager.getTreePage({
				type: "message",
				messageRole: "user",
				direction: "forward",
				limit: 2,
			});
			expect(forward.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[0, firstId],
				[3, secondId],
			]);
			expect(forward.nextOrdinal).toBe(3);

			const reverse = await manager.getTreePage({
				type: "message",
				messageRole: "user",
				direction: "reverse",
				limit: 2,
			});
			expect(reverse.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([
				[3, secondId],
				[5, thirdId],
			]);
			expect(reverse.nextOrdinal).toBe(3);

			const oldest = await manager.getTreePage({
				beforeOrdinal: reverse.nextOrdinal ?? undefined,
				type: "message",
				messageRole: "user",
				direction: "reverse",
				limit: 2,
			});
			expect(oldest.entries.map(({ ordinal, id }) => [ordinal, id])).toEqual([[0, firstId]]);
			expect(oldest.nextOrdinal).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});

	it.each([
		[{ afterOrdinal: -1 }, "afterOrdinal"],
		[{ afterOrdinal: 0.5 }, "afterOrdinal"],
		[{ afterOrdinal: Number.NaN }, "afterOrdinal"],
		[{ afterOrdinal: Number.POSITIVE_INFINITY }, "afterOrdinal"],
		[{ afterOrdinal: Number.MAX_SAFE_INTEGER + 1 }, "afterOrdinal"],
		[{ beforeOrdinal: -1 }, "beforeOrdinal"],
		[{ beforeOrdinal: 0.5 }, "beforeOrdinal"],
		[{ beforeOrdinal: Number.NaN }, "beforeOrdinal"],
		[{ beforeOrdinal: Number.POSITIVE_INFINITY }, "beforeOrdinal"],
		[{ beforeOrdinal: Number.MAX_SAFE_INTEGER + 1 }, "beforeOrdinal"],
		[{ beforeOrdinal: 1, direction: "forward" }, "reverse direction"],
		[{ afterOrdinal: 1, direction: "reverse" }, "forward direction"],
		[{ direction: "sideways" }, "direction"],
		[{ direction: null }, "direction"],
		[{ limit: 0 }, "limit"],
		[{ limit: -1 }, "limit"],
		[{ limit: 1.5 }, "limit"],
		[{ limit: Number.NaN }, "limit"],
		[{ limit: Number.POSITIVE_INFINITY }, "limit"],
		[{ limit: Number.MAX_SAFE_INTEGER + 1 }, "limit"],
		[{ afterOrdinal: 0, beforeOrdinal: 1 }, "mutually exclusive"],
	] as const)("rejects invalid page options %#", async (options, message) => {
		const fixture = createManager();
		let manager = fixture.manager;
		try {
			appendEntries(manager);
			manager = fixture.reopen();
			await expect(manager.getTreePage(options as never)).rejects.toThrow(message);
		} finally {
			fixture.cleanup();
		}
	});

	it("accepts terminal cursors and caps a large safe limit", async () => {
		const fixture = createManager();
		let manager = fixture.manager;
		try {
			const ids = appendEntries(manager);
			manager = fixture.reopen();
			await expect(
				manager.getTreePage({ afterOrdinal: Number.MAX_SAFE_INTEGER, direction: "forward" }),
			).resolves.toEqual({ entries: [], nextOrdinal: null });
			await expect(manager.getTreePage({ beforeOrdinal: 0, direction: "reverse" })).resolves.toEqual({
				entries: [],
				nextOrdinal: null,
			});
			const page = await manager.getTreePage({ limit: 5000 });
			expect(page.entries.map(({ id }) => id)).toEqual(ids);
			expect(page.nextOrdinal).toBeNull();
		} finally {
			fixture.cleanup();
		}
	});
});

async function createAgentSession(sessionManager = SessionManager.inMemory()): Promise<AgentSession> {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		}),
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("AgentSession.getUserMessagesForForkingPage", () => {
	it("pages user choices from every branch without contacting a provider", async () => {
		const session = await createAgentSession();
		try {
			const oldest = session.sessionManager.appendMessage(userMsg("oldest"));
			const branchPoint = session.sessionManager.appendCustomEntry("branch-point");
			const middle = session.sessionManager.appendMessage(userMsg("middle"));
			session.sessionManager.branch(branchPoint);
			const newest = session.sessionManager.appendMessage(userMsg("newest branch"));

			const first = await session.getUserMessagesForForkingPage({ direction: "forward", limit: 2 });
			expect(first.messages).toEqual([
				{ entryId: oldest, text: "oldest" },
				{ entryId: middle, text: "middle" },
			]);
			expect(first.nextOrdinal).toBe(2);

			const last = await session.getUserMessagesForForkingPage({
				afterOrdinal: first.nextOrdinal ?? undefined,
				direction: "forward",
				limit: 2,
			});
			expect(last.messages).toEqual([{ entryId: newest, text: "newest branch" }]);
			expect(last.nextOrdinal).toBeNull();

			const newestPage = await session.getUserMessagesForForkingPage({ direction: "reverse", limit: 2 });
			expect(newestPage.messages).toEqual([
				{ entryId: middle, text: "middle" },
				{ entryId: newest, text: "newest branch" },
			]);
			expect(newestPage.nextOrdinal).toBe(2);

			const oldestPage = await session.getUserMessagesForForkingPage({
				beforeOrdinal: newestPage.nextOrdinal ?? undefined,
				direction: "reverse",
				limit: 2,
			});
			expect(oldestPage.messages).toEqual([{ entryId: oldest, text: "oldest" }]);
			expect(oldestPage.nextOrdinal).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("returns a UTF-8-safe 4 KiB preview", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-paged-preview-"));
		let manager = SessionManager.create(root, root);
		const text = `${"a".repeat(4094)}étail`;
		const entryId = manager.appendMessage(userMsg(text));
		manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Persisted preview session has no file");
		manager.close();
		manager = SessionManager.open(sessionFile, root, root);
		const session = await createAgentSession(manager);
		try {
			const page = await session.getUserMessagesForForkingPage({ limit: 1 });
			expect(page.messages).toEqual([
				{
					entryId,
					text: `${"a".repeat(4094)}é`,
					textTruncated: true,
				},
			]);
			expect(Buffer.byteLength(page.messages[0]!.text)).toBe(4096);
			expect(page.messages[0]!.text).not.toContain("�");
		} finally {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
