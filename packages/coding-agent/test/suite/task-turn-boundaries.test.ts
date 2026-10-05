import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskTurnHandle } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("task turns across canonical boundaries", () => {
	it.each([false, true])(
		"keeps task output across retain-none compaction with persistence=%s",
		async (persistSession) => {
			let compacted = false;
			const harness = await createHarness({
				persistSession,
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", () => {
							if (compacted) return;
							compacted = true;
							return {
								entries: [
									{ type: "compaction", summary: "checkpoint", firstKeptEntryId: null },
									{ type: "custom_message", customType: "continue", content: "finish task", display: false },
								],
								continue: true,
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.sessionManager.appendMessage({ role: "user", content: "prior input", timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("prior answer"));
			harness.session.refreshContext();
			harness.setResponses([fauxAssistantMessage("task result"), fauxAssistantMessage("task final")]);
			const liveRead = vi.spyOn(harness.session.agent.state, "messages", "get").mockImplementation(() => {
				throw new Error("task turns must not adopt persisted history");
			});
			try {
				const handle = harness.session.startTaskTurn("task input");
				const result = await handle.completed;
				expect(result.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
					"task result",
					"task final",
				]);
				expect(result.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"task input",
				]);
				expect(liveRead).not.toHaveBeenCalled();
				expect(harness.sessionManager.buildSessionProjection().messages.map(getMessageText)).not.toContain(
					"task result",
				);
			} finally {
				liveRead.mockRestore();
			}
		},
	);

	it("defers owned task turns requested during settlement until all notifications finish", async () => {
		let handle: TaskTurnHandle | undefined;
		let notified = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (handle) return;
						handle = pi.startTaskTurn("queued task");
						void handle.completed.catch(() => {});
					});
					pi.on("agent_settled", () => {
						notified = true;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("original answer"),
			() => {
				expect(notified).toBe(true);
				return fauxAssistantMessage("queued answer");
			},
		]);
		await harness.session.prompt("original input");
		expect(handle).toBeDefined();
		const result = await handle!.completed;
		expect(result.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
			"queued answer",
		]);
		expect(result.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual(["queued task"]);
	});

	it("persists retry omissions in indexed history without losing task output", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("failed attempt", { stopReason: "error", errorMessage: "overloaded" }),
			(context) => {
				expect(context.messages.map(getMessageText)).not.toContain("failed attempt");
				return fauxAssistantMessage("recovered");
			},
		]);
		const result = await harness.session.startTaskTurn("retry task").completed;
		expect(result.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
			"failed attempt",
			"recovered",
		]);
		const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
		try {
			expect(reopened.buildSessionContext().messages.map(getMessageText)).not.toContain("failed attempt");
			expect(
				reopened
					.getEntries()
					.some((entry) => entry.type === "message" && getMessageText(entry.message) === "failed attempt"),
			).toBe(true);
		} finally {
			reopened.close();
		}
	});

	it.each(["user", "custom"] as const)(
		"rejects task ownership behind an earlier deferred %s message",
		async (kind) => {
			let queued = false;
			let rejected: unknown;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("agent_settled", () => {
							if (queued) return;
							queued = true;
							if (kind === "user") pi.sendUserMessage("earlier");
							else
								pi.sendMessage(
									{ customType: "earlier", content: "earlier", display: false },
									{ triggerTurn: true },
								);
							try {
								pi.startTaskTurn("must not run");
							} catch (error) {
								rejected = error;
							}
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("earlier completed")]);
			await harness.session.prompt("original");
			expect(rejected).toBeInstanceOf(Error);
			expect(String(rejected)).toContain("queued work");
			expect(harness.faux.state.callCount).toBe(2);
			harness.setResponses([fauxAssistantMessage("fresh task completed")]);
			await expect(harness.session.startTaskTurn("fresh task").completed).resolves.toBeDefined();
		},
	);

	it("cancels deferred task dispatch and settles ownership during the settled notification", async () => {
		let handle: TaskTurnHandle | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (handle) return;
						handle = pi.startTaskTurn("must not run");
						await handle.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("original completed"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("original");
		expect(handle).toBeDefined();
		expect((await handle!.completed).messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
		harness.setResponses([fauxAssistantMessage("fresh task completed")]);
		await expect(harness.session.startTaskTurn("fresh task").completed).resolves.toBeDefined();
	});

	it("does not start the provider when a task is aborted during prompt preflight", async () => {
		let begin = () => {};
		let release = () => {};
		const started = new Promise<void>((resolve) => {
			begin = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						begin();
						await blocked;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "queued", content: "next-turn context", display: false },
			{ deliverAs: "nextTurn" },
		);
		const handle = harness.session.startTaskTurn("must not run");
		await started;
		await handle.abort();
		release();
		expect((await handle.completed).messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([
			(context) => {
				expect(
					context.messages.filter((message) => getMessageText(message).includes("next-turn context")),
				).toHaveLength(1);
				return fauxAssistantMessage("received queued context");
			},
		]);
		await harness.session.prompt("next prompt");
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "queued"),
		).toHaveLength(1);
	});

	it("checks ordinary indexed continuations without hydrating discarded ancestry", async () => {
		const harness = await createHarness({
			persistSession: true,
			tools: [
				{
					name: "noop",
					label: "Noop",
					description: "Noop",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(9 * 1024 * 1024), timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old answer"));
		const kept = harness.sessionManager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		harness.sessionManager.appendCompaction("checkpoint", kept, 100);
		harness.session.refreshContext();
		const fullBranch = vi.spyOn(harness.sessionManager, "getBranch").mockImplementation(() => {
			throw new Error("ordinary continuations must not hydrate discarded ancestry");
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("finished"),
			]);
			await harness.session.prompt("continue");
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.getLastAssistantText()).toBe("finished");
			expect(fullBranch).not.toHaveBeenCalled();
		} finally {
			fullBranch.mockRestore();
		}
	});
});
