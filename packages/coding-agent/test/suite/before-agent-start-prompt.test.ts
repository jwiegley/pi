import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

// before_agent_start also fires for runs started by custom messages, which have no user prompt.
// Extensions written before it did read `prompt` without checking `messageType` (for example
// pi-agent-browser-native 0.6.10 calls `prompt.trim()`), so those events carry an empty prompt.
describe("before_agent_start prompt for runs started by custom messages", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** A harness whose before_agent_start handler reads `prompt` the way pre-union extensions do. */
	async function createLegacyPromptHarness(extraExtensions: HarnessOptions["extensionFactories"] = []) {
		const events: BeforeAgentStartEvent[] = [];
		const trimmed: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						events.push(event);
						trimmed.push(event.prompt.trim());
					});
				},
				...(extraExtensions ?? []),
			],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		return { harness, events, trimmed, errors };
	}

	it("gives a run started by a custom message an empty prompt", async () => {
		const { harness, events, trimmed, errors } = await createLegacyPromptHarness();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("  hello  ");
		await harness.session.sendCustomMessage(
			{ customType: "task-done", content: "background task finished", display: true },
			{ triggerTurn: true },
		);

		expect(errors).toEqual([]);
		expect(events.map((event) => [event.messageType, event.prompt])).toEqual([
			["user", "  hello  "],
			["custom", ""],
		]);
		expect(trimmed).toEqual(["hello", ""]);
		const custom = events[1];
		expect(custom?.messageType === "custom" && custom.message.customType).toBe("task-done");
	});

	it("gives a follow-up sent from agent_settled an empty prompt", async () => {
		let followUpSent = false;
		const { harness, events, errors } = await createLegacyPromptHarness([
			(pi) => {
				// Workflow extensions continue a goal this way: the follow-up runs once settled
				// handlers finish, through AgentSession.sendCustomMessage.
				pi.on("agent_settled", () => {
					if (followUpSent) return;
					followUpSent = true;
					pi.sendMessage(
						{ customType: "goal-follow-up", content: "continue", display: false },
						{ triggerTurn: true },
					);
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("start");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(events.map((event) => [event.messageType, event.prompt])).toEqual([
			["user", "start"],
			["custom", ""],
		]);
	});
});
