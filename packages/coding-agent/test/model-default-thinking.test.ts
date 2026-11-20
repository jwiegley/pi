import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader, userMsg } from "./utilities.ts";

const PROVIDER = "model-default-thinking";

describe("model-local default thinking level", () => {
	let tempDir: string;
	let modelRuntime: ModelRuntime;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-default-thinking-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					[PROVIDER]: {
						api: "openai-completions",
						apiKey: "test-key",
						baseUrl: "https://example.test/v1",
						models: [
							{ id: "plain", reasoning: false },
							{ id: "definition-off", reasoning: true, defaultThinkingLevel: "off" },
							{
								id: "clamped-off",
								reasoning: true,
								defaultThinkingLevel: "off",
								thinkingLevelMap: { off: null },
							},
							{ id: "override-off", reasoning: true },
							{ id: "no-default", reasoning: true },
						],
						modelOverrides: {
							"override-off": { defaultThinkingLevel: "off" },
						},
					},
				},
			}),
		);
		modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
	});

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function model(id: string) {
		const result = modelRuntime.getModel(PROVIDER, id);
		if (!result) throw new Error(`Missing test model: ${id}`);
		return result;
	}

	async function session(options: {
		modelId: string;
		thinkingLevel?: ThinkingLevel;
		defaultThinkingLevel?: ThinkingLevel;
		restoredThinkingLevel?: ThinkingLevel;
	}): Promise<AgentSession> {
		const sessionManager = SessionManager.inMemory(tempDir);
		if (options.restoredThinkingLevel !== undefined) {
			sessionManager.appendMessage(userMsg("existing"));
			sessionManager.appendThinkingLevelChange(options.restoredThinkingLevel);
		}
		const settingsManager = SettingsManager.inMemory(
			options.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: options.defaultThinkingLevel },
		);
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: model(options.modelId),
			thinkingLevel: options.thinkingLevel,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
		});
		sessions.push(result.session);
		return result.session;
	}

	it("propagates definition and override defaults to runtime models", () => {
		expect(model("definition-off").defaultThinkingLevel).toBe("off");
		expect(model("override-off").defaultThinkingLevel).toBe("off");
		expect(model("no-default").defaultThinkingLevel).toBeUndefined();
	});

	it.each([
		{ models: [{ id: "bad", defaultThinkingLevel: "high" }] },
		{ modelOverrides: { bad: { defaultThinkingLevel: "high" } } },
	])("rejects a non-off model default", async (provider) => {
		const modelsPath = join(tempDir, `invalid-${Math.random()}.json`);
		writeFileSync(modelsPath, JSON.stringify({ providers: { invalid: provider } }));
		expect((await ModelConfig.load(modelsPath)).getError()).toContain("Invalid models.json schema");
	});

	it.each([
		{ name: "model-local", modelId: "definition-off", expected: "off" },
		{ name: "explicit", modelId: "definition-off", thinkingLevel: "high", expected: "high" },
		{ name: "global", modelId: "definition-off", defaultThinkingLevel: "high", expected: "high" },
		{ name: "restored", modelId: "definition-off", restoredThinkingLevel: "high", expected: "high" },
		{
			name: "explicit over restored and global",
			modelId: "definition-off",
			thinkingLevel: "low",
			restoredThinkingLevel: "high",
			defaultThinkingLevel: "minimal",
			expected: "low",
		},
		{
			name: "restored over global",
			modelId: "definition-off",
			restoredThinkingLevel: "high",
			defaultThinkingLevel: "low",
			expected: "high",
		},
		{ name: "built-in", modelId: "no-default", expected: "medium" },
	] satisfies Array<{
		name: string;
		modelId: string;
		thinkingLevel?: ThinkingLevel;
		defaultThinkingLevel?: ThinkingLevel;
		restoredThinkingLevel?: ThinkingLevel;
		expected: ThinkingLevel;
	}>)("uses $name startup precedence", async ({ expected, ...options }) => {
		expect((await session(options)).thinkingLevel).toBe(expected);
	});

	it("uses switch precedence without breaking thinking-level cycling", async () => {
		const local = await session({ modelId: "plain" });
		await local.setModel(model("override-off"));
		expect(local.thinkingLevel).toBe("off");
		expect(local.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
		expect(local.cycleThinkingLevel()).toBe("minimal");

		const clamped = await session({ modelId: "plain" });
		await clamped.setModel(model("clamped-off"));
		expect(clamped.thinkingLevel).toBe("minimal");
		expect(clamped.settingsManager.getDefaultThinkingLevel()).toBeUndefined();

		const global = await session({ modelId: "plain", defaultThinkingLevel: "high" });
		await global.setModel(model("override-off"));
		expect(global.thinkingLevel).toBe("high");
		expect(global.settingsManager.getDefaultThinkingLevel()).toBe("high");

		const scoped = await session({ modelId: "plain", defaultThinkingLevel: "high" });
		scoped.setScopedModels([{ model: model("plain") }, { model: model("override-off"), thinkingLevel: "low" }]);
		expect((await scoped.cycleModel())?.thinkingLevel).toBe("low");

		const fallback = await session({ modelId: "plain" });
		await fallback.setModel(model("no-default"));
		expect(fallback.thinkingLevel).toBe("medium");

		const reasoning = await session({ modelId: "no-default", restoredThinkingLevel: "high" });
		expect(reasoning.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
		await reasoning.setModel(model("definition-off"));
		expect(reasoning.thinkingLevel).toBe("high");
	});
});
