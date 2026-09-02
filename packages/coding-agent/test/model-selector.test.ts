import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("keeps an explicitly empty scope closed instead of falling back to all models", async () => {
		harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
			scopedModels: [],
		});
		expect(harness.session.hasModelScope).toBe(true);
		expect(await harness.session.cycleModel()).toBeUndefined();

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			true,
		);
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Scope: all | scoped");
		expect(rendered).not.toContain("one");
		expect(rendered).not.toContain("two");
	});

	it("updates or disables scope models and references atomically", async () => {
		harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		const second = harness.models[1];
		harness.session.setScopedModelReferences(["factory/stale"]);
		harness.session.setScopedModels([{ model: second, thinkingLevel: "high" }]);
		expect(harness.session.scopedModelReferences).toEqual([`${second.provider}/${second.id}:high`]);
		expect(harness.session.scopedModels[0]?.thinkingLevel).toBe("high");

		harness.session.setScopedModels(undefined);
		expect(harness.session.hasModelScope).toBe(false);
		expect(harness.session.scopedModelReferences).toBeUndefined();
	});

	it("keeps late provider registrations outside an existing exact scope", async () => {
		harness = await createHarness({ models: [{ id: "selected", name: "Selected" }] });
		const selected = harness.models[0];
		harness.session.setScopedModels([{ model: selected }]);
		harness.session.modelRuntime.registerProvider("factory", {
			name: "Factory",
			baseUrl: "https://factory.example.invalid",
			apiKey: "faux-key",
			api: selected.api,
			models: [
				{
					id: "new-model",
					name: "New Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
				},
			],
		});

		expect(harness.session.modelRuntime.getAvailableSnapshot().some((model) => model.provider === "factory")).toBe(
			true,
		);
		expect(harness.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual([
			`${selected.provider}/${selected.id}`,
		]);

		harness.session.modelRuntime.unregisterProvider(selected.provider);
		expect(harness.session.scopedModels).toEqual([]);
		harness.session.modelRuntime.registerProvider(selected.provider, {
			name: "Faux",
			baseUrl: selected.baseUrl,
			apiKey: "faux-key",
			api: selected.api,
			models: [
				{
					id: selected.id,
					name: selected.name,
					reasoning: selected.reasoning,
					input: selected.input,
					cost: selected.cost,
					contextWindow: selected.contextWindow,
					maxTokens: selected.maxTokens,
				},
			],
		});
		expect(harness.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual([
			`${selected.provider}/${selected.id}`,
		]);
	});

	it("re-resolves a selected unavailable model during the open Ctrl-L refresh", async () => {
		harness = await createHarness({ models: [{ id: "selected", name: "Selected" }] });
		const selected = harness.models[0];
		const reference = `${selected.provider}/${selected.id}`;
		harness.session.setScopedModels([{ model: selected }]);
		harness.session.setScopedModelReferences([reference]);
		let available = false;
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() =>
			available ? [selected] : [],
		);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(async () => {
			available = true;
			return { aborted: false, errors: new Map() };
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			harness.session.scopedModels,
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			true,
			() => harness?.session.scopedModels ?? [],
		);
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain(selected.id);
		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain(selected.id);
			expect(rendered).toContain("Model catalogs refreshed.");
		});
	});

	it("does not let direct /model lookup or provider counts bypass an explicit empty scope", async () => {
		harness = await createHarness({ models: [{ id: "outside", name: "Outside" }], scopedModels: [] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");
		const findExactModelMatch = Reflect.get(InteractiveMode.prototype, "findExactModelMatch") as (
			this: object,
			searchTerm: string,
		) => Promise<unknown>;
		const context = {
			session: harness.session,
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		};
		expect(
			await findExactModelMatch.call(context, `${harness.models[0].provider}/${harness.models[0].id}`),
		).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();

		const setAvailableProviderCount = vi.fn();
		const updateAvailableProviderCount = Reflect.get(InteractiveMode.prototype, "updateAvailableProviderCount") as (
			this: object,
		) => void;
		updateAvailableProviderCount.call({
			session: harness.session,
			footerDataProvider: { setAvailableProviderCount },
		});
		expect(setAvailableProviderCount).toHaveBeenCalledWith(0);
	});
});
