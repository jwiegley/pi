import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createInteractiveContext(options: {
	allModels: Model<Api>[];
	enabledModelIds?: string[];
	scopedModels?: Array<{ model: Model<Api> }>;
	scopedModelReferences?: string[];
	modelScopeConfigured?: boolean;
	persistedScope?: boolean;
	modelScopeSource?: "cli" | "settings";
}) {
	let selector: ScopedModelsSelectorComponent | undefined;
	const setScopedModels = vi.fn();
	const setScopedModelReferences = vi.fn();
	const setModelScopeSource = vi.fn();
	const setEnabledModels = vi.fn();
	const getAvailableSnapshot = vi.fn(() => options.allModels);
	const context = {
		session: {
			modelRuntime: {
				refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
				getAvailableSnapshot,
			},
			scopedModels: options.scopedModels ?? [],
			scopedModelReferences:
				options.persistedScope === false ? undefined : (options.scopedModelReferences ?? options.enabledModelIds),
			modelScopeSource:
				options.modelScopeSource ??
				(options.persistedScope === false || options.enabledModelIds === undefined ? undefined : "settings"),
			hasModelScope: options.modelScopeConfigured ?? true,
			setScopedModels,
			setScopedModelReferences,
			setModelScopeSource,
		},
		settingsManager: {
			getEnabledModels: () => options.enabledModelIds,
			setEnabledModels,
		},
		showStatus: vi.fn(),
		showSelector: (factory: (done: () => void) => { component: ScopedModelsSelectorComponent }) => {
			selector = factory(() => {}).component;
		},
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return {
		context,
		getAvailableSnapshot,
		getSelector: () => selector,
		setScopedModels,
		setScopedModelReferences,
		setModelScopeSource,
		setEnabledModels,
	};
}

async function showModelsSelector(context: object): Promise<void> {
	const show = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => Promise<void>;
	await show.call(context);
}

describe("issue #6949 unavailable scoped models", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("shows and removes an enabled model without a catalog entry", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		harnesses.push(harness);
		const availableId = `${harness.models[0].provider}/${harness.models[0].id}`;
		const unavailableId = `${harness.models[0].provider}/unavailable`;
		const changes: Array<string[] | null> = [];
		const persisted: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: [unavailableId, availableId],
			},
			{
				onChange: (enabledIds) => {
					changes.push(enabledIds);
				},
				onPersist: (enabledIds) => {
					persisted.push(enabledIds);
				},
				onCancel: () => {},
			},
		);

		const rendered = selector.render(100).join("\n");
		expect(stripAnsi(rendered)).toContain(`${unavailableId} [unavailable]`);
		expect(rendered).toContain(theme.strikethrough(unavailableId));
		selector.handleInput("\r");
		expect(changes).toEqual([[availableId]]);
		selector.handleInput("\x13");
		expect(persisted).toEqual([[availableId]]);
	});

	it("passes unmatched settings patterns to the selector with one combined resolution", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		harnesses.push(harness);
		const unavailableIds = ["unavailable-one", "unavailable-two"].map((id) => `${harness.models[0].provider}/${id}`);
		const { context, getAvailableSnapshot, getSelector } = createInteractiveContext({
			allModels: [],
			enabledModelIds: unavailableIds,
		});

		await showModelsSelector(context);

		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		const rendered = stripAnsi(selector.render(100).join("\n"));
		for (const unavailableId of unavailableIds) {
			expect(rendered).toContain(`${unavailableId} [unavailable]`);
		}
		expect(getAvailableSnapshot).toHaveBeenCalled();
	});

	it("opens when only a session-scoped model is unavailable", async () => {
		const harness = await createHarness({ models: [{ id: "unavailable", name: "Unavailable" }] });
		harnesses.push(harness);
		const model = harness.models[0];
		const fullId = `${model.provider}/${model.id}`;
		const { context, getSelector } = createInteractiveContext({
			allModels: [],
			enabledModelIds: [],
			scopedModels: [{ model }],
			persistedScope: false,
		});

		await showModelsSelector(context);

		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain(`${fullId} [unavailable]`);
	});

	it("does not clear a partial scope when an enabled model is unavailable", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
				{ id: "three", name: "Three" },
			],
		});
		harnesses.push(harness);
		const [one, two] = harness.models;
		const enabledIds = [one, two].map((model) => `${model.provider}/${model.id}`);
		const unavailableId = `${one.provider}/unavailable`;
		const { context, getSelector, setScopedModels } = createInteractiveContext({
			allModels: [...harness.models],
			enabledModelIds: [...enabledIds, unavailableId],
			scopedModels: [{ model: one }, { model: two }],
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		selector.handleInput("\x1b[1;3B");

		await vi.waitFor(() => {
			expect(setScopedModels).toHaveBeenLastCalledWith([
				{ model: two, thinkingLevel: undefined },
				{ model: one, thinkingLevel: undefined },
			]);
		});
	});

	it("treats provider wildcards as unavailable instead of selecting current and future models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		harnesses.push(harness);
		const factoryModels = harness.models.map((model) => ({ ...model, provider: "factory" }));
		const { context, getSelector, setScopedModelReferences } = createInteractiveContext({
			allModels: factoryModels,
			enabledModelIds: ["factory/*"],
			scopedModels: [],
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(100).join("\n"));
			expect(rendered).toContain("factory/* [unavailable]");
			expect(rendered).toContain("one [factory]");
			expect(rendered).toContain("two [factory]");
			expect(rendered).not.toContain("✓");
			expect(setScopedModelReferences).toHaveBeenLastCalledWith(["factory/*"]);
		});
	});

	it("persists enable-all as exact identities so later discoveries remain excluded", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		harnesses.push(harness);
		const [one, two] = harness.models;
		const ids = [one, two].map((model) => `${model.provider}/${model.id}`);
		const { context, getSelector, setEnabledModels, setScopedModels } = createInteractiveContext({
			allModels: [...harness.models],
			enabledModelIds: [ids[0]],
			scopedModels: [{ model: one }],
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		selector.handleInput("\x01");
		selector.handleInput("\x13");
		expect(setEnabledModels).toHaveBeenLastCalledWith(ids);
		expect(setScopedModels).toHaveBeenLastCalledWith([
			{ model: one, thinkingLevel: undefined },
			{ model: two, thinkingLevel: undefined },
		]);
	});

	it("persists an explicitly empty scope without reopening all models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		harnesses.push(harness);
		const one = harness.models[0];
		const { context, getSelector, setEnabledModels, setScopedModels } = createInteractiveContext({
			allModels: [...harness.models],
			enabledModelIds: [`${one.provider}/${one.id}`],
			scopedModels: [{ model: one }],
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		selector.handleInput("\x18");
		selector.handleInput("\x13");
		expect(setEnabledModels).toHaveBeenLastCalledWith([]);
		expect(setScopedModels).toHaveBeenLastCalledWith([]);
	});

	it("does not let an empty CLI scope fall back to persisted settings", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		harnesses.push(harness);
		const persistedId = `${harness.models[0].provider}/${harness.models[0].id}`;
		const { context, getSelector, setModelScopeSource } = createInteractiveContext({
			allModels: [...harness.models],
			enabledModelIds: [persistedId],
			scopedModels: [],
			scopedModelReferences: [],
			modelScopeSource: "cli",
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(100).join("\n"));
			expect(rendered).toContain("one [faux]");
			expect(rendered).toContain("two [faux]");
			expect(rendered).not.toContain("✓");
			expect(setModelScopeSource).toHaveBeenLastCalledWith("cli");
		});
	});

	it("freezes an unscoped catalogue to exact identities when saved", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		harnesses.push(harness);
		const ids = harness.models.map((model) => `${model.provider}/${model.id}`);
		const { context, getSelector, setEnabledModels, setScopedModels, setScopedModelReferences, setModelScopeSource } =
			createInteractiveContext({
				allModels: [...harness.models],
				enabledModelIds: undefined,
				scopedModels: [],
				modelScopeConfigured: false,
			});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		selector.handleInput("\x13");
		expect(setEnabledModels).toHaveBeenLastCalledWith(ids);
		expect(setScopedModels).toHaveBeenLastCalledWith(
			harness.models.map((model) => ({ model, thinkingLevel: undefined })),
		);
		expect(setScopedModelReferences).toHaveBeenLastCalledWith(ids);
		expect(setModelScopeSource).toHaveBeenLastCalledWith("settings");
	});

	it("preserves thinking suffixes while opening, refreshing, and saving", async () => {
		const harness = await createHarness({ models: [{ id: "one", name: "One" }] });
		harnesses.push(harness);
		const model = harness.models[0];
		const reference = `${model.provider}/${model.id}:high`;
		const { context, getSelector, setEnabledModels, setScopedModelReferences } = createInteractiveContext({
			allModels: [...harness.models],
			enabledModelIds: [reference],
			scopedModels: [{ model }],
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		await vi.waitFor(() => expect(setScopedModelReferences).toHaveBeenLastCalledWith([reference]));
		selector.handleInput("\x13");
		expect(setEnabledModels).toHaveBeenLastCalledWith([reference]);
	});
});
