import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
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

function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const row = stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.find((line) => line.startsWith("→"));
	return row?.replace(/^→\s*(✓\s*)?/, "").split(" ")[0];
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

	// #5916
	it("shows model names that differ from the ID", async () => {
		harness = await createHarness({
			models: [
				{ id: "minimax/minimax-m3", name: "MiniMax M3 [parasail]" },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			],
		});
		const provider = harness.getModel("minimax/minimax-m3")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.slice(4).trimEnd());
		expect(rows).toContain(`minimax/minimax-m3 (MiniMax M3 [parasail]) [${provider}]`);
		expect(rows).toContain(`claude-sonnet-4-5 [${provider}]`);
		selector.dispose();
	});

	it("moves by one page with remapped selection page keys (#7629)", async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.pageUp": "alt+v", "tui.select.pageDown": "ctrl+v" }));
		harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({ id: `model-${String(index).padStart(2, "0")}` })),
		});
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);

		selector.handleInput("\x16"); // Ctrl+V
		selector.handleInput("\x16");
		selector.handleInput("\x1bv"); // Alt+V
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "model-01" }));
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

	// #9109
	describe("when the catalog refresh lands", () => {
		// Opens the selector with the refresh in flight, so a test can browse first and then let it land.
		async function openWithPendingRefresh(): Promise<{
			activeHarness: Harness;
			selector: ModelSelectorComponent;
			finishRefresh: () => Promise<void>;
		}> {
			const activeHarness = await createHarness({
				models: [{ id: "alpha-1" }, { id: "alpha-2" }, { id: "alpha-3" }, { id: "beta-1" }],
			});
			harness = activeHarness;
			const { promise, resolve } = Promise.withResolvers<ModelsRefreshResult>();
			vi.spyOn(activeHarness.session.modelRuntime, "refresh").mockReturnValue(promise);
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				activeHarness.getModel("alpha-1"),
				activeHarness.session.modelRuntime,
				[],
				() => {},
				() => {},
			);
			const finishRefresh = async () => {
				resolve({ aborted: false, errors: new Map() });
				await vi.waitFor(() => {
					expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
				});
			};
			return { activeHarness, selector, finishRefresh };
		}

		it("keeps the selection on the browsed model", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-3");
			selector.dispose();
		});

		it("keeps the selection while a search query is active", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			for (const char of "alpha") selector.handleInput(char);
			selector.handleInput("\x1b[B");
			const browsed = selectedModelId(selector);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe(browsed);
			expect(browsed).not.toBe("alpha-1");
			selector.dispose();
		});

		it("follows the selected model when new rows shift its position", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const snapshot = modelRuntime.getAvailableSnapshot();
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([
				{ ...snapshot[0], id: "added-model" },
				...snapshot,
			]);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-2");
			selector.handleInput("\x1b[A");
			selector.handleInput("\x1b[A");
			expect(selectedModelId(selector)).toBe("alpha-1");
			selector.dispose();
		});

		it("falls back to the current model when the selected model disappears", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const remaining = modelRuntime.getAvailableSnapshot().filter((model) => model.id !== "alpha-2");
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(remaining);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-1");
			selector.dispose();
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
