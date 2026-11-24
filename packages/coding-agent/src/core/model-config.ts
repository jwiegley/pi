/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelInputModalitySchema,
	ModelPromptCacheSchema,
	PartialModelCostSchema,
	ProviderCompatSchema,
	ThinkingLevelMapSchema,
} from "./pi-ai-schemas.ts";
import { accountsProblem, type ProviderAccount } from "./provider-accounts.ts";

const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
const SamplingParamsByThinkingLevelSchema = Type.Object(
	{
		off: Type.Optional(SamplingParamsSchema),
		minimal: Type.Optional(SamplingParamsSchema),
		low: Type.Optional(SamplingParamsSchema),
		medium: Type.Optional(SamplingParamsSchema),
		high: Type.Optional(SamplingParamsSchema),
		xhigh: Type.Optional(SamplingParamsSchema),
		max: Type.Optional(SamplingParamsSchema),
	},
	{ description: "samplingParams per thinking level, merged over samplingParams." },
);

const SamplingParamsFieldSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: "Fields merged into every request body. Applies only to OpenAI-compatible APIs.",
});
const HeadersSchema = Type.Record(Type.String(), Type.String(), {
	description: "Request headers. Values resolve like apiKey.",
});

/** Model fields shared by models entries and modelOverrides entries. Defaults apply only to models entries. */
const ModelFieldDescriptions = {
	name: "Display name, also matched by --model patterns.",
	reasoning: "Whether the model supports thinking.",
	contextWindow: "Context window in tokens.",
	maxTokens: "Maximum output tokens.",
} as const;
const ProviderTransportSchema = Type.Object(
	{
		requestTimeoutMs: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 2147483647,
				description:
					"Request timeout in milliseconds. Takes precedence over retry.provider.timeoutMs and httpIdleTimeoutMs, but not over a per-call timeout.",
			}),
		),
		idleTimeoutMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 2147483647,
				description:
					"HTTP idle timeout in milliseconds; 0 disables it. Applies only where the API adapter uses Pi's fetch: Bedrock and WebSocket transports ignore it.",
			}),
		),
	},
	{ description: "Timeouts for this provider's requests only." },
);
/** Describes defaultThinkingLevel in models entries and modelOverrides entries. */
const DefaultThinkingLevelDescription =
	'Thinking level to start with when no explicit, session, per-model, or global level applies, including after a switch from a model without thinking. Only "off" is accepted.';

const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Model ID sent to the API." }),
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	api: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider api." })),
	baseUrl: Type.Optional(Type.String({ minLength: 1, description: "Overrides the provider baseUrl." })),
	reasoning: Type.Optional(Type.Boolean({ default: false, description: ModelFieldDescriptions.reasoning })),
	defaultThinkingLevel: Type.Optional(Type.Literal("off", { description: DefaultThinkingLevelDescription })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema, { default: ["text"] })),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(ModelCostSchema),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 128000, description: ModelFieldDescriptions.contextWindow }),
	),
	maxTokens: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, default: 16384, description: ModelFieldDescriptions.maxTokens }),
	),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: ModelFieldDescriptions.name })),
	reasoning: Type.Optional(Type.Boolean({ description: ModelFieldDescriptions.reasoning })),
	defaultThinkingLevel: Type.Optional(Type.Literal("off", { description: DefaultThinkingLevelDescription })),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema)),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: Type.Optional(PartialModelCostSchema),
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.contextWindow }),
	),
	maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: ModelFieldDescriptions.maxTokens })),
	samplingParams: Type.Optional(SamplingParamsFieldSchema),
	samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, description: "Display name." })),
	baseUrl: Type.Optional(
		Type.String({ minLength: 1, description: "API base URL. Also applies to the provider's built-in models." }),
	),
	apiKey: Type.Optional(
		Type.String({
			minLength: 1,
			description: 'Literal key, "$NAME" environment interpolation, or "!command" output.',
		}),
	),
	api: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				'API for the provider\'s models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai".',
		}),
	),
	oauth: Type.Optional(Type.Literal("radius", { description: "OAuth login flow. Requires baseUrl." })),
	headers: Type.Optional(HeadersSchema),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(
		Type.Boolean({ default: false, description: "Whether to send the resolved API key as Authorization: Bearer." }),
	),
	transport: Type.Optional(ProviderTransportSchema),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
	accountOf: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Makes this provider another account of the named provider: the same models, login and requests, with its own credential. The named provider is then reachable only through its accounts.",
		}),
	),
	aliases: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Earlier provider IDs of this account. Sessions and model references that name one resolve to this account; no list shows them. Requires accountOf.",
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"The only environment variables the provider's authentication sees for this account, as literal values. Requires accountOf.",
		}),
	),
});

const ModelsConfigProperties = {
	providers: Type.Record(Type.String(), ProviderConfigSchema),
};

export const ModelsConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	...ModelsConfigProperties,
});

/** Entry schemas rendered into docs/models-configuration.md. */
export const ModelsJsonSchemas = {
	provider: ProviderConfigSchema,
	model: ModelDefinitionSchema,
	modelOverride: ModelOverrideSchema,
};

const validateModelsConfig = Compile(ModelsConfigSchema);

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly accounts = new Map<string, ProviderAccount>();
	private readonly accountsByBase = new Map<string, ProviderAccount[]>();
	private readonly aliases = new Map<string, string>();
	private readonly error: string | undefined;

	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		this.providers = providers;
		this.error = error;
		for (const [id, provider] of providers) {
			if (provider.accountOf === undefined) continue;
			const account: ProviderAccount = {
				id,
				accountOf: provider.accountOf,
				name: provider.name,
				aliases: provider.aliases ?? [],
				env: provider.env ?? {},
			};
			this.accounts.set(id, account);
			this.accountsByBase.set(account.accountOf, [...(this.accountsByBase.get(account.accountOf) ?? []), account]);
			for (const alias of account.aliases) this.aliases.set(alias, id);
		}
	}

	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return new ModelConfig(
				new Map(),
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(parsed.providers)) {
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		const problem = accountsProblem(providers);
		if (problem) return new ModelConfig(new Map(), `Invalid models.json accounts:\n  - ${problem}\n\nFile: ${path}`);
		return new ModelConfig(providers);
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	/** The account a provider ID declares, if it is one. */
	getAccount(providerId: string): ProviderAccount | undefined {
		return this.accounts.get(providerId);
	}

	/** The accounts of a provider. A provider with any is reachable only through them. */
	getAccountsOf(providerId: string): readonly ProviderAccount[] {
		return this.accountsByBase.get(providerId) ?? [];
	}

	/** The account an earlier provider ID now names, or the ID itself. */
	resolveAlias(providerId: string): string {
		return this.aliases.get(providerId) ?? providerId;
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	getError(): string | undefined {
		return this.error;
	}
}
