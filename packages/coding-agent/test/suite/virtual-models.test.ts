import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import {
	type ModelRecovery,
	type ModelRecoveryRequest,
	type ModelRoute,
	type ModelRouteRequest,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "../../src/core/virtual-models.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

type Route = (request: ModelRouteRequest, ctx: ExtensionContext) => ModelRoute;

/** Router used by these tests: new user turns pick by thinking level, everything else stays put. */
const defaultRoute: Route = (request, ctx) => {
	const find = (id: string) => ctx.modelRegistry.find("faux", id)!;
	if (request.reason === "direct") return { model: find("large"), thinkingLevel: "low" };
	const sticky = request.failed ?? request.previous;
	if (request.reason !== "user" && sticky) {
		return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "high" };
	}
	return request.thinkingLevel === "high"
		? { model: find("large"), thinkingLevel: "high" }
		: { model: find("small"), thinkingLevel: "off" };
};

describe("AgentSession virtual models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRoutedHarness(
		route: Route = defaultRoute,
		options: HarnessOptions = {},
		recover?: (
			request: ModelRecoveryRequest,
			ctx: ExtensionContext,
		) => ModelRecovery | undefined | Promise<ModelRecovery | undefined>,
	) {
		const requests: ModelRouteRequest[] = [];
		const harness = await createHarness({
			...options,
			models: [
				{ id: "small", contextWindow: 1000 },
				{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
				{ id: "medium", contextWindow: 50_000 },
				{ id: "other", contextWindow: 50_000 },
			],
			tools: [echoTool],
			extensionFactories: [
				...(options.extensionFactories ?? []),
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						thinkingLevels: ["low", "high"],
						contextWindow: 1000,
						route(request, ctx) {
							requests.push(request);
							return route(request, ctx);
						},
						...(recover ? { recover } : {}),
					});
				},
			],
		});
		harnesses.push(harness);
		// Stream through the runtime, which records the thinking level on responses.
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		harness.session.setThinkingLevel("high");
		const reasons = () => requests.map((request) => request.reason);
		/** Physical model and thinking level recorded on each response. */
		const dispatched = () =>
			harness.session.messages.flatMap((message) =>
				message.role === "assistant" ? [`${message.provider}/${message.model}:${message.thinkingLevel}`] : [],
			);
		return { harness, requests, reasons, dispatched };
	}

	it("recovers a failed virtual request with a distinct physical model", async () => {
		const seen: ModelRecoveryRequest[] = [];
		const { harness, dispatched } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			(request, ctx) => {
				seen.push(request);
				return {
					kind: "error",
					status: 400,
					route: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" },
				};
			},
		);
		const contexts: string[] = [];
		const stream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			contexts.push(JSON.stringify(context.messages));
			return stream(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "400 bad request" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("hello");
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({ reason: "user", physical: { id: "large" }, attempts: [] });
		expect(dispatched()).toEqual(["faux/small:off"]);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]).toContain("hello");
		expect(contexts[1]).not.toContain("partial");
		expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant")).toHaveLength(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
	});

	it("keeps the original response when no alternate is offered", async () => {
		const { harness, dispatched } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			() => undefined,
		);
		harness.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "400 bad request" })]);
		await harness.session.prompt("hello");
		expect(dispatched()).toEqual(["faux/large:high"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(0);
	});

	it("restores the original when confirmation withdraws the alternate", async () => {
		let calls = 0;
		const { harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			(_request, ctx) =>
				++calls === 1
					? { kind: "error", route: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" } }
					: undefined,
		);
		harness.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "400 bad request" })]);
		await harness.session.prompt("hello");
		expect(calls).toBe(2);
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && message.model === "large"),
		).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && message.model === "small"),
		).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(2);
	});

	it("stops after distinct models report the same 4xx", async () => {
		const seen: ModelRecoveryRequest[] = [];
		const { harness, dispatched } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			(request, ctx) => {
				seen.push(request);
				const next = request.physical.id === "large" ? "medium" : "other";
				return {
					kind: "error",
					status: 400,
					route: { model: ctx.modelRegistry.find("faux", next)!, thinkingLevel: "off" },
				};
			},
		);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 bad request" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 bad request" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(dispatched()).toEqual(["faux/medium:off"]);
		expect(seen).toHaveLength(3);
		expect(seen[2].attempts).toMatchObject([{ model: { provider: "faux", id: "large" }, status: 400 }]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("offers at most one alternate after a degenerate outcome", async () => {
		const { harness, dispatched } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			(request, ctx) => ({
				kind: "degenerate",
				route: {
					model: ctx.modelRegistry.find("faux", request.physical.id === "large" ? "medium" : "other")!,
					thinkingLevel: "off",
				},
			}),
		);
		harness.setResponses([
			fauxAssistantMessage("repeat", { stopReason: "length" }),
			fauxAssistantMessage("repeat again", { stopReason: "length" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(dispatched()).toEqual(["faux/medium:off"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("offers a degenerate alternate before length compaction", async () => {
		const { harness, dispatched } = await createRoutedHarness(
			defaultRoute,
			{
				settings: {
					retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
					compaction: { enabled: true, reserveTokens: 1_000 },
				},
			},
			(_request, ctx) => ({
				kind: "degenerate",
				route: { model: ctx.modelRegistry.find("faux", "medium")!, thinkingLevel: "off" },
			}),
		);
		harness.setResponses([
			fauxAssistantMessage("repeat", { stopReason: "length" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(dispatched()).toEqual(["faux/medium:off"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not offer recovery for context overflow", async () => {
		const recover = vi.fn();
		const { harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			recover,
		);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
		]);
		await harness.session.prompt("hello");
		expect(recover).not.toHaveBeenCalled();
	});

	it("bounds error recovery to three alternates", async () => {
		const { harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			(request, ctx) => {
				const next = (
					{ large: "medium", medium: "other", other: "small", small: "large" } as Record<string, string>
				)[request.physical.id];
				return {
					kind: "error",
					status: 500,
					route: { model: ctx.modelRegistry.find("faux", next)!, thinkingLevel: "off" },
				};
			},
		);
		harness.setResponses([
			...Array.from({ length: 4 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 failure" }),
			),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant")).toHaveLength(4);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("never recovers a response containing a tool call", async () => {
		const recover = vi.fn();
		const { harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			recover,
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), {
				stopReason: "error",
				errorMessage: "400 invalid",
			}),
		]);
		await harness.session.prompt("hello");
		expect(recover).not.toHaveBeenCalled();
	});

	it("restores the failed attempt when selection changes during confirmation", async () => {
		let calls = 0;
		let harness: Harness;
		({ harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			async (_request, ctx) => {
				if (++calls === 2) await harness.session.setModel(harness.getModel("other")!);
				return { kind: "error", route: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" } };
			},
		));
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "400 invalid" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(calls).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && message.model === "large"),
		).toBe(true);
	});

	it("restores the failed attempt when the branch changes before confirmation", async () => {
		let calls = 0;
		let harness: Harness;
		({ harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			(_request, ctx) => {
				if (++calls === 2) harness.sessionManager.appendCustomEntry("test.branch-moved", {});
				return { kind: "error", route: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" } };
			},
		));
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "400 invalid" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(calls).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && message.model === "large"),
		).toBe(true);
	});

	it("declines an alternate the conversation does not fit, leaving the original response as it was", async () => {
		const { harness, dispatched } = await createRoutedHarness(
			defaultRoute,
			{
				settings: {
					retry: { enabled: false },
					compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
				},
			},
			(_request, ctx) => ({
				kind: "error",
				route: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" },
			}),
		);
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "400 invalid" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("x".repeat(8000));
		expect(dispatched()).toEqual(["faux/large:high"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(0);
	});

	it("does not recover after cancellation during the offer", async () => {
		let offered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			offered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness } = await createRoutedHarness(
			defaultRoute,
			{
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			},
			async (_request, ctx) => {
				offered();
				await gate;
				return { kind: "error", route: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" } };
			},
		);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid" }),
			fauxAssistantMessage("should not run"),
		]);
		const run = harness.session.prompt("hello");
		await started;
		const abort = harness.session.abort();
		release();
		await Promise.all([run, abort]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(0);
	});

	it("routes each request, including retries, while the selection stays virtual", async () => {
		const { harness, requests, reasons, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		expect(reasons()).toEqual(["user", "retry", "continuation"]);
		expect(requests[1].failed?.message.errorMessage).toBe("overloaded_error");
		expect(requests[2].previous?.model.id).toBe("large");
		expect(dispatched()).toEqual(["faux/large:high", "faux/large:high"]);
		expect(harness.session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(harness.session.thinkingLevel).toBe("high");
		// Limits come from the physical model that produced the latest response, not the virtual model.
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("retries the first request of a turn on the model routed for that turn", async () => {
		const { harness, requests, reasons, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.session.setThinkingLevel("low");
		harness.setResponses([
			fauxAssistantMessage("easy answer"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("hard answer"),
		]);
		await harness.session.prompt("easy");
		harness.session.setThinkingLevel("high");

		await harness.session.prompt("hard");

		expect(reasons()).toEqual(["user", "user", "retry"]);
		// The retry reports the failed request on large next to the small response of the previous turn.
		expect(requests[2].failed?.model.id).toBe("large");
		expect(requests[2].previous?.model.id).toBe("small");
		expect(dispatched()).toEqual(["faux/small:off", "faux/large:high"]);
	});

	it("routes the compact-and-retry after a truncated response as a retry", async () => {
		const { harness, requests, reasons } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "overflow compacted", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["overflow"]);
		// Compaction may fold the prompt into the summary, so the retry is not a new user turn.
		expect(reasons()).toEqual(["user", "retry"]);
		expect(requests[1].failed?.model.id).toBe("large");
		expect(requests[1].failed?.message.stopReason).toBe("length");
	});

	it("routes requests after extension messages as continuations", async () => {
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			extensionFactories: [
				(pi) => {
					let continued = false;
					pi.on("agent_before_settle", () => {
						if (continued) return undefined;
						continued = true;
						return {
							entries: [{ type: "custom_message", customType: "nudge", content: "Keep going.", display: false }],
							continue: true,
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");

		// The hidden custom message becomes a user message for the model, but the user did not write it.
		expect(reasons()).toEqual(["user", "continuation"]);
	});

	it("routes the first request of a prompt as a user turn when extension messages follow the prompt", async () => {
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "context", content: "Extra context.", display: false },
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");
		await harness.session.prompt("again");

		// The context ends with the extension message, but the request answers the user's prompt.
		expect(harness.session.messages.at(-2)?.role).toBe("custom");
		expect(reasons()).toEqual(["user", "user"]);
	});

	it("ends the run with an error response when routing fails and keeps the last physical limits", async () => {
		let fail = false;
		const { harness } = await createRoutedHarness((request, ctx) => {
			if (fail) throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		});
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("hello");

		fail = true;
		await harness.session.prompt("again");

		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: "router",
			model: "auto",
			stopReason: "error",
			errorMessage: expect.stringContaining("router unavailable"),
		});
		expect(harness.faux.state.callCount).toBe(1);
		// The failed attempt names the virtual model, whose declared window is 1k; the large model's 50k applies.
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("checks compaction against the physical model that produced the response", async () => {
		const { harness } = await createRoutedHarness();
		harness.setResponses([fauxAssistantMessage("short answer"), fauxAssistantMessage("long answer")]);
		await harness.session.prompt("hello");

		// About 20k tokens exceed the virtual model's declared 1k window but fit the large model's 50k.
		await harness.session.prompt("x".repeat(80_000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("compacts before a request routed to a model with a smaller window", async () => {
		const { harness, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "compacted", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		let compactedBeforeSmall = false;
		harness.setResponses([
			fauxAssistantMessage("y".repeat(8000)),
			() => {
				compactedBeforeSmall = harness.eventsOfType("compaction_end").length === 1;
				return fauxAssistantMessage("small answer");
			},
		]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

		// About 2k tokens fit the large model that answered last, but not the small model's 1k window.
		harness.session.setThinkingLevel("low");
		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(compactedBeforeSmall).toBe(true);
		expect(dispatched().at(-1)).toBe("faux/small:off");
	});

	it("compacts between turns of a run when the next request is routed to a smaller window", async () => {
		const route: Route = (request, ctx) =>
			request.reason === "continuation"
				? { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" }
				: defaultRoute(request, ctx);
		const { harness, dispatched } = await createRoutedHarness(route, {
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "compacted", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		let compactedBeforeSmall = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			() => {
				compactedBeforeSmall = harness.eventsOfType("compaction_end").length === 1;
				return fauxAssistantMessage("small answer");
			},
		]);

		// About 2k tokens fit the large model of the first turn, but not the small model of the second.
		await harness.session.prompt("x".repeat(8000));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(compactedBeforeSmall).toBe(true);
		expect(dispatched()).toEqual(["faux/large:high", "faux/small:off"]);
	});

	it("projects the session once per request under a virtual selection", async () => {
		const { harness } = await createRoutedHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const projections = vi.spyOn(harness.sessionManager, "buildSessionProjection");

		await harness.session.prompt("hello");

		// One per request, one between the turns, and one for the compaction check after the run.
		expect(projections).toHaveBeenCalledTimes(4);
	});

	it("stores router state on the branch and passes it to later requests", async () => {
		const states: unknown[] = [];
		const { harness, reasons } = await createRoutedHarness(
			(request, ctx) => {
				states.push(request.state);
				const turns = (request.state as { turns: number } | undefined)?.turns ?? 0;
				const route = defaultRoute(request, ctx);
				// Returning request.state keeps it without storing it again. Direct requests neither get nor store state.
				if (request.reason === "continuation") return { ...route, state: request.state };
				return { ...route, state: { turns: turns + 1 } };
			},
			{ settings: { compaction: { keepRecentTokens: 1 } } },
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("summary"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const stored = () =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY ? [entry.data] : [],
				);
		expect(stored()).toEqual([
			{ provider: "router", modelId: "auto", state: { turns: 1 } },
			{ provider: "router", modelId: "auto", state: { turns: 2 } },
		]);

		await harness.session.compact();

		expect(reasons()).toEqual(["user", "continuation", "user", "direct"]);
		expect(states).toEqual([undefined, { turns: 1 }, { turns: 1 }, undefined]);
		expect(stored()).toHaveLength(2);
	});

	it("does not route compactions that an extension supplies", async () => {
		const route: Route = (request, ctx) => {
			if (request.reason === "direct") throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		};
		const { harness, reasons } = await createRoutedHarness(route, {
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "extension summary", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toBe("extension summary");
		expect(reasons()).toEqual(["user", "user"]);
	});

	it("routes compaction summaries to the resolved model", async () => {
		const summaries: string[] = [];
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		const summary: FauxResponseStep = (_context, options, _state, model) => {
			summaries.push(`${model.id}:${options?.reasoning ?? "off"}`);
			return fauxAssistantMessage("summary");
		};
		// Compaction summarizes the history and the split turn prefix with one routed model.
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			summary,
			summary,
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary");
		expect(reasons()).toEqual(["user", "user", "direct"]);
		// The router's model and thinking level apply. The provider layer sizes output from that model.
		expect(summaries).toEqual(["large:low", "large:low"]);
	});
});
