// Another account of a provider: the same models, login and request code under a second id, with
// its own stored credential.
import {
	type AnyModel,
	type AssistantMessageEvent,
	type AuthContext,
	lazyStream,
	type Provider,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/** One `accountOf` entry of models.json. */
export interface ProviderAccount {
	/** The account's provider id, such as `openrouter-p`. */
	readonly id: string;
	/** The provider this is an account of, such as `openrouter`. */
	readonly accountOf: string;
	readonly name?: string;
	/** Earlier ids of this account. Old sessions name them; no list shows them. */
	readonly aliases: readonly string[];
	/**
	 * The only environment the base's auth sees for this account, as literal values. The process
	 * environment is withheld: one `GOOGLE_API_KEY` there would otherwise log every account in.
	 */
	readonly env: Readonly<Record<string, string>>;
}

/**
 * Wrap `base` as the provider of one account. The base sees its own id on every model and on the
 * account's earlier messages, so its request code behaves exactly as it does for the base provider;
 * everything it returns carries the account's id.
 */
export function accountProvider(account: ProviderAccount, base: Provider): Provider {
	const ownIds = new Set([account.id, ...account.aliases]);
	// Keyed by the base's model objects, so a base that returns the same objects gets the same ones back.
	const relabelled = new WeakMap<AnyModel, AnyModel>();
	const toAccount = <TModel extends AnyModel>(model: TModel): TModel => {
		let own = relabelled.get(model);
		if (!own) {
			own = { ...model, provider: account.id };
			relabelled.set(model, own);
		}
		// The copy differs from `model` only in its provider.
		return own as TModel;
	};
	const toBase = <TModel extends AnyModel>(model: TModel): TModel => ({ ...model, provider: base.id });
	const filterWith = <TModel extends AnyModel>(
		models: readonly TModel[],
		filter: (models: readonly TModel[]) => readonly TModel[],
	): readonly TModel[] => {
		const originals = new Map(models.map((model) => [toBase(model), model]));
		return filter([...originals.keys()]).map((model) => originals.get(model) ?? toAccount(model));
	};
	const toBaseTranscript = (context: TranscriptContext): TranscriptContext => {
		const isOwn = (message: TranscriptContext["messages"][number]) =>
			message.role === "assistant" && ownIds.has(message.provider);
		if (!context.messages.some(isOwn)) return context;
		return {
			...context,
			messages: context.messages.map((message) => (isOwn(message) ? { ...message, provider: base.id } : message)),
		};
	};
	const accountContext = (ctx: AuthContext): AuthContext => ({
		env: async (name) => (Object.hasOwn(account.env, name) ? account.env[name] : undefined),
		fileExists: (path) => ctx.fileExists(path),
	});

	// A key the base is configured with (models.json `apiKey`, an extension's default) belongs to no
	// one account, so an account is configured only by its own stored credential or its own `env`.
	const hasOwnAuth = (credential: object | undefined) =>
		credential !== undefined || Object.keys(account.env).length > 0;
	const { apiKey, oauth } = base.auth;
	const { filterModels, filterAllModels, refreshModels, fetchDeferred, cancelDeferred, generateImages, classify } =
		base;
	const provider: Provider = {
		id: account.id,
		name: account.name ?? `${base.name} (${account.id})`,
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: {
			...(oauth ? { oauth } : {}),
			...(apiKey
				? {
						apiKey: {
							...apiKey,
							check: apiKey.check
								? async (input) =>
										hasOwnAuth(input.credential)
											? apiKey.check!({ ...input, ctx: accountContext(input.ctx) })
											: undefined
								: undefined,
							resolve: async (input) =>
								hasOwnAuth(input.credential)
									? apiKey.resolve({ ...input, ctx: accountContext(input.ctx) })
									: undefined,
						},
					}
				: {}),
		},
		getModels: () => base.getModels().map(toAccount),
		getAllModels: () => (base.getAllModels?.() ?? base.getModels()).map(toAccount),
		refreshModelsAuth: base.refreshModelsAuth,
		refreshModels: refreshModels ? (context) => refreshModels.call(base, context) : undefined,
		filterModels: filterModels
			? (models, credential) => filterWith(models, (baseModels) => filterModels.call(base, baseModels, credential))
			: undefined,
		filterAllModels: filterAllModels
			? (models, credential) =>
					filterWith(models, (baseModels) => filterAllModels.call(base, baseModels, credential))
			: undefined,
		stream: (model, context, options) =>
			lazyStream(
				model,
				async () => asAccount(base.stream(toBase(model), toBaseTranscript(context), options), account.id),
				undefined,
				options?.signal,
			),
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => asAccount(base.streamSimple(toBase(model), toBaseTranscript(context), options), account.id),
				undefined,
				options?.signal,
			),
	};
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) =>
			lazyStream(
				model,
				async () => asAccount(fetchDeferred.call(base, toBase(model), handle, options), account.id),
				undefined,
				options?.signal,
			);
	}
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred.call(base, toBase(model), handle, options);
	}
	if (generateImages) {
		provider.generateImages = async (model, context, options) => ({
			...(await generateImages.call(base, toBase(model), context, options)),
			provider: account.id,
		});
	}
	if (classify) {
		provider.classify = async (model, context, options) => ({
			...(await classify.call(base, toBase(model), context, options)),
			provider: account.id,
		});
	}
	return provider;
}

/** Name the account on every message of the base's stream. The messages are the base's own objects. */
async function* asAccount(
	events: AsyncIterable<AssistantMessageEvent>,
	accountId: string,
): AsyncIterable<AssistantMessageEvent> {
	for await (const event of events) {
		const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
		message.provider = accountId;
		yield event;
	}
}

/** What `accountsProblem` reads of one models.json provider entry. */
export interface AccountEntry {
	accountOf?: string;
	aliases?: readonly string[];
	env?: Readonly<Record<string, string>>;
}

/** The first problem with the `accountOf` entries of models.json, if any. Wire input, checked once per load. */
export function accountsProblem(providers: ReadonlyMap<string, AccountEntry>): string | undefined {
	const bases = new Set<string>();
	for (const provider of providers.values()) if (provider.accountOf !== undefined) bases.add(provider.accountOf);
	const aliases = new Set<string>();
	for (const [id, provider] of providers) {
		if (provider.accountOf === undefined) {
			if (provider.aliases || provider.env) return `${id}: "aliases" and "env" need "accountOf"`;
			continue;
		}
		if (provider.accountOf === id) return `${id}: cannot be an account of itself`;
		if (bases.has(id)) return `${id}: is an account, so it cannot have accounts of its own`;
		const extra = Object.keys(provider).find((key) => !ACCOUNT_KEYS.has(key));
		if (extra !== undefined) {
			return `${id}: an account takes only "accountOf", "name", "aliases" and "env", not "${extra}". Configure ${provider.accountOf} instead`;
		}
		for (const alias of provider.aliases ?? []) {
			if (providers.has(alias)) return `${id}: the alias "${alias}" is a provider`;
			if (bases.has(alias)) return `${id}: the alias "${alias}" has accounts, so it names no one account`;
			if (aliases.has(alias)) return `${id}: the alias "${alias}" is given twice`;
			aliases.add(alias);
		}
	}
	return undefined;
}

const ACCOUNT_KEYS: ReadonlySet<string> = new Set(["accountOf", "name", "aliases", "env"]);
