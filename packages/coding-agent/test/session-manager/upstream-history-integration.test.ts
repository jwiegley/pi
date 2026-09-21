import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";

describe("upstream behavior with bounded history", () => {
	it("includes cache-warming usage in memory, indexed history, and reopened history", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-history-usage-"));
		const manager = SessionManager.create(dir, dir);
		const usage = {
			input: 2,
			output: 3,
			cacheRead: 5,
			cacheWrite: 7,
			totalTokens: 17,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		try {
			manager.appendUsage("cache_warm", "test", "test-model", usage, "warm");
			expect(manager.getHistorySummary().usage).toEqual({
				input: 2,
				output: 3,
				cacheRead: 5,
				cacheWrite: 7,
				cost: 10,
			});
			manager.flush();
			manager.appendUsage("cache_warm", "test", "test-model", usage);
			manager.close();
			const reopened = SessionManager.open(manager.getSessionFile()!);
			try {
				expect(reopened.getHistorySummary().usage).toEqual({
					input: 4,
					output: 6,
					cacheRead: 10,
					cacheWrite: 14,
					cost: 20,
				});
				expect(getUsageCostBreakdown(reopened.getEntries())).toEqual([
					{ key: "test/test-model", cost: 20, tokens: 34 },
				]);
				expect((await reopened.getTreePage()).entries.map((entry) => entry.entryPreview?.type)).toEqual([
					"usage",
					"usage",
				]);
				expect(reopened.buildSessionContext().messages).toEqual([]);
			} finally {
				reopened.close();
			}
		} finally {
			manager.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([false, true])("replays compacted prompt/tool state with deferred payloads=%s", (large) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-history-system-"));
		const memory = SessionManager.inMemory(dir);
		const indexed = SessionManager.create(dir, dir);
		try {
			for (const manager of [memory, indexed]) {
				manager.appendMessage({ role: "system", content: "base", sections: { rules: "old" }, timestamp: 1 });
				const kept = manager.appendMessage({
					role: "user",
					content: large ? "x".repeat(9 * 1024 * 1024) : "question",
					timestamp: 2,
				});
				manager.appendMessage({
					role: "system",
					content: "delta",
					sections: { rules: "new" },
					toolsAdded: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
					timestamp: 3,
				});
				manager.appendMessage(fauxAssistantMessage("answer"));
				manager.appendCompaction("summary", kept, 100);
			}
			const expected = memory.buildSessionContext().messages;
			const source = indexed.buildSessionContextSource().messages;
			expect(source.length).toBe(expected.length);
			expect(source.materialize().map((message) => message.role)).toEqual([
				"system",
				"compactionSummary",
				"user",
				"assistant",
			]);
			expect([...source.iterateReverse()].map((message) => message.role)).toEqual([
				"assistant",
				"user",
				"compactionSummary",
				"system",
			]);
			expect(source.last("system")).toMatchObject({
				content: "base\n\ndelta",
				sections: { rules: "new" },
				toolsAdded: [{ name: "read" }],
			});
			expect(indexed.getCurrentSystemMessage()).toMatchObject({
				content: "base\n\ndelta",
				sections: { rules: "new" },
			});
			expect(getCurrentSystemMessage(source.materialize())).toMatchObject({ content: "base\n\ndelta" });
			expect(
				indexed
					.getActiveContextEntries()
					.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
			).toEqual(["compaction", "user", "assistant"]);
		} finally {
			indexed.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays and resets a deferred Agent system baseline without materializing its source", async () => {
		const agent = new Agent({
			streamFn: async () => {
				throw new Error("unused");
			},
			initialState: { systemPrompt: "initial" },
		});
		expect(agent.state.messages[0]).toMatchObject({ role: "system", content: "initial" });
		const messages: AgentMessage[] = [{ role: "system", content: "base", timestamp: 1 }];
		agent.setMessageSource({
			length: 1,
			materialize: () => {
				throw new Error("must stay deferred");
			},
			last: () => messages[0],
			iterateReverse: () => messages.values(),
		});
		agent.appendMessage({ role: "system", content: "delta", timestamp: 2 });
		expect(agent.state.systemPrompt).toBe("base\n\ndelta");
		await expect(agent.continue()).rejects.toThrow("No messages to continue from");
		agent.reset();
		expect(agent.messageCount).toBe(1);
		expect((agent.lastMessage as SystemMessage).content).toBe("base\n\ndelta");
	});

	it("preserves a label-based compaction cut when branching indexed history", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-history-branch-"));
		const manager = SessionManager.create(dir, dir);
		try {
			const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage("answer"));
			const label = manager.appendLabelChange(first, "keep");
			manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
			const compaction = manager.appendCompaction("summary", label, 100);
			manager.createBranchedSession(compaction);
			expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"compactionSummary",
				"user",
			]);
		} finally {
			manager.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
