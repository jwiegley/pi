import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type Model,
	type Provider,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function modelsJson(providers: Record<string, unknown>): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-provider-accounts-"));
	directories.push(directory);
	const path = join(directory, "models.json");
	writeFileSync(path, JSON.stringify({ providers }));
	return path;
}

function createRuntime(providers: Record<string, unknown>, credentials = new InMemoryCredentialStore()) {
	return ModelRuntime.create({
		credentials,
		modelsPath: modelsJson(providers),
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
}

interface Seen {
	modelProvider: string;
	apiKey: string | undefined;
	historyProviders: string[];
}

/** A keyed provider that records what its request code is given, and answers as itself. */
function serviceProvider(seen: Seen[]): Provider {
	const model: Model<Api> = {
		id: "m1",
		name: "M1",
		api: "openai-completions",
		provider: "service",
		baseUrl: "https://service.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const answer = (requested: Model<Api>, context: TranscriptContext, apiKey: string | undefined) => {
		seen.push({
			modelProvider: requested.provider,
			apiKey,
			historyProviders: context.messages.flatMap((message) =>
				message.role === "assistant" ? [message.provider] : [],
			),
		});
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: requested.api,
			provider: requested.provider,
			model: requested.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	return {
		id: "service",
		name: "Service",
		auth: {
			apiKey: {
				name: "Service key",
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "Key" }),
				}),
				resolve: async ({ ctx, credential }) => {
					const key = credential?.key ?? (await ctx.env("SERVICE_API_KEY"));
					return key ? { auth: { apiKey: key }, source: "service" } : undefined;
				},
			},
		},
		getModels: () => [model],
		stream: (requested, context, options) => answer(requested, context, options?.apiKey),
		streamSimple: (requested, context, options) => answer(requested, context, options?.apiKey),
	};
}

const twoAccounts = {
	"service-j": { accountOf: "service", name: "Service (John)", aliases: ["service-2"] },
	"service-p": { accountOf: "service", aliases: ["service-3"] },
};

describe("provider accounts", () => {
	it("gives each account the provider's models under its own id, and hides the bare provider", async () => {
		const runtime = await createRuntime(twoAccounts);
		runtime.registerNativeProvider(serviceProvider([]));

		const ids = runtime.getProviders().map((provider) => provider.id);
		expect(ids).toContain("service-j");
		expect(ids).toContain("service-p");
		expect(ids).not.toContain("service");
		expect(runtime.getModel("service", "m1")).toBeUndefined();
		expect(runtime.getModel("service-j", "m1")).toMatchObject({ provider: "service-j", id: "m1" });
		expect(runtime.getProvider("service-j")?.accountOf).toBe("service");
		expect(runtime.getProvider("service-j")?.name).toBe("Service (John)");
		expect(runtime.getProvider("service-p")?.name).toBe("Service (service-p)");
		expect(runtime.getError()).toBeUndefined();
	});

	it("keeps one credential per account, both logged in at once", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("service-j", async () => ({ type: "api_key", key: "john-key" }));
		const runtime = await createRuntime(twoAccounts, credentials);
		runtime.registerNativeProvider(serviceProvider([]));
		await runtime.login("service-p", "api_key", { prompt: async () => "positron-key", notify: () => {} });

		expect((await runtime.getAuth("service-j"))?.auth.apiKey).toBe("john-key");
		expect((await runtime.getAuth("service-p"))?.auth.apiKey).toBe("positron-key");
		expect(await credentials.read("service")).toBeUndefined();
		expect((await runtime.getAvailable("service-j")).map((model) => model.provider)).toEqual(["service-j"]);
		expect((await runtime.getAvailable("service-p")).map((model) => model.provider)).toEqual(["service-p"]);
	});

	it("sends a request with the account's key, as the provider's own model, and names the account on the answer", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("service-p", async () => ({ type: "api_key", key: "positron-key" }));
		const seen: Seen[] = [];
		const runtime = await createRuntime(twoAccounts, credentials);
		runtime.registerNativeProvider(serviceProvider(seen));
		const model = runtime.getModel("service-p", "m1");
		if (!model) throw new Error("no account model");

		const first = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		expect(first.provider).toBe("service-p");
		// A session recorded under the account's earlier id is the account's own history too.
		const earlier: AssistantMessage = { ...first, provider: "service-3" };
		await runtime.completeSimple(model, {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				first,
				earlier,
				{ role: "user", content: "again", timestamp: 2 },
			],
		});

		expect(seen).toEqual([
			{ modelProvider: "service", apiKey: "positron-key", historyProviders: [] },
			{ modelProvider: "service", apiKey: "positron-key", historyProviders: ["service", "service"] },
		]);
	});

	it("has a late-registered provider's accounts available at once when they hold a credential", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("service-j", async () => ({ type: "api_key", key: "john-key" }));
		const runtime = await createRuntime(twoAccounts, credentials);

		runtime.registerNativeProvider(serviceProvider([]));

		expect(runtime.hasConfiguredAuth("service-j")).toBe(true);
		expect(runtime.hasConfiguredAuth("service-p")).toBe(false);
		expect(runtime.getAvailableSnapshot().map((model) => model.provider)).toContain("service-j");
	});

	it("lets an extension wrap a provider that has accounts, and gives the accounts the replacement", async () => {
		const runtime = await createRuntime({ "openrouter-j": { accountOf: "openrouter" } });
		const registry = new ModelRegistry(runtime);
		const builtin = registry.getProvider("openrouter");
		if (!builtin) throw new Error("no base");
		expect(runtime.getProvider("openrouter")).toBeUndefined();

		runtime.registerNativeProvider({ ...builtin, getModels: () => builtin.getModels().slice(0, 1) });

		expect(runtime.getProvider("openrouter")).toBeUndefined();
		expect(runtime.getModels("openrouter-j")).toHaveLength(1);
	});

	it("gives each account its own instance of a provider that offers one", async () => {
		const made: Record<string, string>[] = [];
		const runtime = await createRuntime({
			"service-j": { accountOf: "service", env: { SERVICE_DIR: "/j" } },
			"service-p": { accountOf: "service", env: { SERVICE_DIR: "/p" } },
		});
		const shared = serviceProvider([]);
		runtime.registerNativeProvider({
			...shared,
			forAccount: (env) => {
				made.push({ ...env });
				const [model] = shared.getModels();
				return { ...shared, getModels: () => [{ ...model, id: `m${env.SERVICE_DIR}` }] };
			},
		});
		await runtime.refresh({ allowNetwork: false });

		expect(made).toEqual([{ SERVICE_DIR: "/j" }, { SERVICE_DIR: "/p" }]);
		expect(runtime.getModels("service-j").map((model) => model.id)).toEqual(["m/j"]);
		expect(runtime.getModels("service-p").map((model) => model.id)).toEqual(["m/p"]);
	});

	it("resolves an account's earlier ids without listing them", async () => {
		const runtime = await createRuntime(twoAccounts);
		runtime.registerNativeProvider(serviceProvider([]));

		expect(runtime.getModel("service-2", "m1")).toBe(runtime.getModel("service-j", "m1"));
		expect(runtime.getPhysicalModel("service-3", "m1")?.provider).toBe("service-p");
		expect(runtime.getProviders().map((provider) => provider.id)).not.toContain("service-2");
		expect(runtime.getModels().map((model) => model.provider)).not.toContain("service-2");
	});

	it("withholds the process environment and a key configured for the bare provider", async () => {
		process.env.SERVICE_API_KEY = "ambient-key";
		try {
			const runtime = await createRuntime({
				"service-j": { accountOf: "service" },
				"service-p": { accountOf: "service", env: { SERVICE_API_KEY: "positron-env-key" } },
			});
			runtime.registerNativeProvider(serviceProvider([]));
			await runtime.refresh({ allowNetwork: false });

			expect(runtime.hasConfiguredAuth("service-j")).toBe(false);
			expect(await runtime.getAuth("service-j")).toBeUndefined();
			expect((await runtime.getAuth("service-p"))?.auth.apiKey).toBe("positron-env-key");
		} finally {
			delete process.env.SERVICE_API_KEY;
		}
	});

	it("makes accounts of a built-in provider", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openrouter-p", async () => ({ type: "api_key", key: "positron-key" }));
		const runtime = await createRuntime(
			{ "openrouter-j": { accountOf: "openrouter" }, "openrouter-p": { accountOf: "openrouter" } },
			credentials,
		);

		expect(runtime.getProvider("openrouter")).toBeUndefined();
		const models = runtime.getModels("openrouter-p");
		expect(models.length).toBeGreaterThan(0);
		expect(new Set(models.map((model) => model.provider))).toEqual(new Set(["openrouter-p"]));
		expect(runtime.hasConfiguredAuth("openrouter-p")).toBe(true);
		expect(runtime.hasConfiguredAuth("openrouter-j")).toBe(false);
		// The login method is the provider's own.
		expect(runtime.getProvider("openrouter-j")?.auth.apiKey?.login).toBeDefined();
	});

	it.each([
		[{ a: { accountOf: "a" } }, "cannot be an account of itself"],
		[{ a: { accountOf: "b" }, b: { accountOf: "c" } }, "cannot have accounts of its own"],
		[{ a: { accountOf: "b", baseUrl: "https://x.test" } }, 'not "baseUrl"'],
		[{ a: { accountOf: "b", aliases: ["b"] } }, "names no one account"],
		[{ a: { accountOf: "b", aliases: ["x"] }, c: { accountOf: "b", aliases: ["x"] } }, "given twice"],
		[{ a: { baseUrl: "https://x.test", aliases: ["x"] } }, 'need "accountOf"'],
	])("refuses %j", async (providers, problem) => {
		const runtime = await createRuntime(providers);
		expect(runtime.getError()).toContain(problem);
	});
});
