/**
 * The virtual-model recovery boundary with a real router: jwiegley/pi-smart-router, loaded from the
 * checkout that PI_SMART_ROUTER_CHECKOUT names. Skipped without it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const checkout = process.env.PI_SMART_ROUTER_CHECKOUT;

describe.skipIf(!checkout)("pi-smart-router on the recovery boundary", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	async function routed(first: "faux" | "google" = "faux"): Promise<Harness> {
		const router = (await import(pathToFileURL(join(checkout!, "index.ts")).href)) as { default: InlineExtension };
		const dir = mkdtempSync(join(tmpdir(), "smart-router-recovery-"));
		writeFileSync(
			join(dir, "smart-router.json"),
			JSON.stringify({
				version: 1,
				roles: [
					{
						name: "worker",
						models: [first === "google" ? "google/gemini-4-hydrogen" : "faux/large", "faux/medium"],
					},
				],
				routing: { default: "worker", trivial: "worker", complex: "worker", planning: "worker" },
			}),
			{ mode: 0o600 },
		);
		const prior = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		const harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 50_000 },
				{ id: "medium", contextWindow: 50_000 },
			],
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [router.default],
		});
		cleanups.push(() => {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
			if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prior;
		});
		const runtime = harness.session.modelRuntime;
		if (first === "google") {
			runtime.registerProvider("google", {
				api: "google-generative-ai",
				apiKey: "fixture-key",
				baseUrl: "https://example.invalid/v1beta",
				models: [
					{
						id: "gemini-4-hydrogen",
						name: "Hydrogen",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 50_000,
						maxTokens: 4_096,
						thinkingLevelMap: {
							off: null,
							minimal: null,
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "invalid",
							max: null,
						},
					},
				],
			});
			await runtime.refresh({ allowNetwork: false });
		}
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("smart-router", "auto")!);
		if (first === "google") harness.session.setThinkingLevel("xhigh");
		return harness;
	}

	const answered = (harness: Harness) =>
		harness
			.eventsOfType("message_end")
			.flatMap((event) => (event.message.role === "assistant" ? [event.message.model] : []));
	const inContext = (harness: Harness) =>
		harness.session.messages.flatMap((message) => (message.role === "assistant" ? [message.model] : []));

	it.each([
		["a request the model itself refused", "400 invalid request"],
		["a usage limit Pi does not retry", "You have hit your usage limit. Try again in ~42 min."],
	])("moves %s to the role's next model in the same run", async (_name, errorMessage) => {
		const harness = await routed();
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("hello");
		expect(answered(harness)).toEqual(["large", "medium"]);
		expect(inContext(harness)).toEqual(["medium"]);
	});

	it("recovers an invalid Google thinking map before output through the real router", async () => {
		const harness = await routed("google");
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.prompt("hello");
		expect(answered(harness)).toEqual(["gemini-4-hydrogen", "medium"]);
		expect(inContext(harness)).toEqual(["medium"]);
		const failed = harness
			.eventsOfType("message_end")
			.find((event) => event.message.role === "assistant" && event.message.model === "gemini-4-hydrogen");
		expect(failed?.message).toMatchObject({
			stopReason: "error",
			content: [],
			errorMessage: expect.stringContaining("xhigh -> invalid"),
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("never moves content a model refused", async () => {
		const harness = await routed();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 content policy violation" }),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("hello");
		expect(answered(harness)).toEqual(["large"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
