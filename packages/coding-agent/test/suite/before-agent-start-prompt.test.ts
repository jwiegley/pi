import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type { BeforeAgentStartCustomEvent, BeforeAgentStartEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

// before_agent_start also fires for runs started by pi.sendMessage(..., { triggerTurn: true }).
// As in upstream Pi, those events carry the starting message and no prompt, so handlers that read
// the prompt check messageType first.
describe("before_agent_start for runs started by custom messages", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** A harness that records every before_agent_start event and extension error. */
	async function createRecordingHarness(extraExtensions: NonNullable<HarnessOptions["extensionFactories"]> = []) {
		const events: BeforeAgentStartEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						events.push(event);
					});
				},
				...extraExtensions,
			],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		return { harness, events, errors };
	}

	/** What started each run: a user prompt, or a custom message and whether its event has a prompt. */
	const runStarts = (events: BeforeAgentStartEvent[]) =>
		events.map((event) =>
			event.messageType === "user"
				? { messageType: event.messageType, prompt: event.prompt }
				: { messageType: event.messageType, customType: event.message.customType, hasPrompt: "prompt" in event },
		);

	it("declares no prompt on custom-message events", () => {
		expectTypeOf<BeforeAgentStartCustomEvent>().not.toHaveProperty("prompt");
	});

	it("gives a run started by sendCustomMessage its message and no prompt", async () => {
		const { harness, events, errors } = await createRecordingHarness();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");
		await harness.session.sendCustomMessage(
			{ customType: "task-done", content: "background task finished", display: true },
			{ triggerTurn: true },
		);

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(runStarts(events)).toEqual([
			{ messageType: "user", prompt: "hello" },
			{ messageType: "custom", customType: "task-done", hasPrompt: false },
		]);
	});

	it("gives a follow-up sent from agent_settled its message and no prompt", async () => {
		let followUpSent = false;
		const { harness, events, errors } = await createRecordingHarness([
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
		expect(runStarts(events)).toEqual([
			{ messageType: "user", prompt: "start" },
			{ messageType: "custom", customType: "goal-follow-up", hasPrompt: false },
		]);
	});
});
