// Models omitted from the live catalog, regenerated from synthetic upstream entries for regression tests.
import { buildCatalog } from "../catalog/build.ts";
import copilot from "../catalog/providers/github-copilot.ts";
import groq from "../catalog/providers/groq.ts";
import opencode from "../catalog/providers/opencode.ts";
import type { CatalogSources } from "../catalog/sources/index.ts";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { hasApi } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

function source(id: string, baseUrl: string, context: number, output: number): ModelsDevV2Model {
	return {
		id,
		type: "chat",
		name: id,
		modalities: { input: ["text", "image"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning: { supported: true } },
		limit: { context, output },
		api: { "chat-completions": { base_url: baseUrl } },
	};
}

const qwen = source("qwen/qwen3.6-27b", "https://api.groq.com/openai/v1", 131_072, 16_384);
qwen.capabilities.reasoning.effort = ["none", "high"];
const kimi25 = source("kimi-k2.5", "https://opencode.ai/inference/openai/v1", 262_144, 65_536);
const kimi26 = source("kimi-k2.6", "https://opencode.ai/inference/openai/v1", 262_144, 65_536);
const opus5 = source("claude-opus-5", "https://api.individual.githubcopilot.com", 128_000, 64_000);
const sources: CatalogSources = {
	modelsDev: {
		groq: { models: { [qwen.id]: qwen } },
		opencode: { models: { [kimi25.id]: kimi25, [kimi26.id]: kimi26 } },
		"github-copilot": { models: { [opus5.id]: opus5 } },
	},
	modelsDevDecisions: {},
	openRouter: { chat: [], images: [], classifiers: [] },
	aiGateway: { chat: [], classifiers: [] },
	nvidiaModelIds: new Map(),
	radius: { chat: [], images: [], classifiers: [] },
};
const catalogs = buildCatalog([groq, opencode, copilot], sources, true);

function fixture<TApi extends Api>(provider: string, id: string, api: TApi): Model<TApi> {
	const model = catalogs[provider]?.chat.find((entry) => entry.id === id);
	if (!model || !hasApi(model, api)) throw new Error(`Missing ${provider}/${id} fixture for ${api}`);
	return model;
}

export const GROQ_QWEN_36 = fixture("groq", qwen.id, "openai-completions");
export const OPENCODE_KIMI_25 = fixture("opencode", kimi25.id, "openai-completions");
export const OPENCODE_KIMI_26 = fixture("opencode", kimi26.id, "openai-completions");
export const COPILOT_OPUS_5 = fixture("github-copilot", opus5.id, "anthropic-messages");
