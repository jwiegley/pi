import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// Upstream #11227 finds a failed attempt's tool results in the projected context. A resumed
// indexed session holds that context as a deferred source, which recovery must not adopt.
describe("recovery with a deferred transcript", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("omits a resumed truncated call and its result without adopting the transcript", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "check status", timestamp: now - 1000 });
		const truncated: AssistantMessage = {
			...fauxAssistantMessage([fauxToolCall("bash", { command: "echo" }, { id: "call_truncated" })], {
				stopReason: "length",
				timestamp: now - 500,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 16,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 116,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		harness.sessionManager.appendMessage(truncated);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_truncated",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Not executed: output token limit reached." }],
			timestamp: now - 400,
		});
		harness.sessionManager.flush();

		// Resume as createAgentSession does: the agent reads the indexed context as a deferred source.
		const agent = harness.session.agent;
		agent.setMessageSource(harness.sessionManager.buildSessionContextSource().messages);
		const liveRead = vi.spyOn(agent.state, "messages", "get").mockImplementation(() => {
			throw new Error("recovery must not adopt the deferred transcript");
		});

		let requestMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				requestMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);

		try {
			await harness.session.prompt("continue");
			// Check before mockRestore(), which clears the recorded calls.
			expect(liveRead).not.toHaveBeenCalled();
		} finally {
			liveRead.mockRestore();
		}

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(requestMessages.map((message) => message.role)).not.toContain("toolResult");
		expect(requestMessages.some((m) => m.role === "assistant" && m.stopReason === "length")).toBe(false);
	});
});
