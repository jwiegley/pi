import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../../src/core/export-html/tool-renderer.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("extension tool renderer wrappers", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("wraps resolver overrides and unregistered tools exactly once across late registrations", async () => {
		const calls: string[] = [];
		let api: ExtensionAPI | undefined;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerToolRenderer((name, next) => {
						if (name === "read")
							return { ...next(), renderCall: () => ({ render: () => ["resolver"], invalidate: () => {} }) };
						return (
							next() ??
							(name === "mcp__docs__search"
								? {
										renderCall: () => ({ render: () => ["unregistered"], invalidate: () => {} }),
									}
								: undefined)
						);
					});
					pi.registerToolRendererWrapper((tool, renderers) => {
						const previous = renderers.renderCall;
						if (!previous) return renderers;
						return {
							...renderers,
							renderCall: (...args) => ({
								render: (width) => {
									calls.push(tool.name);
									return ["wrapped", ...previous(...args).render(width)];
								},
								invalidate: () => {},
							}),
						};
					});
				},
			],
		});
		const render = (name: string) =>
			harness!.session
				.getToolRenderers(name)
				?.renderCall?.({}, {} as never, {} as never)
				.render(80);
		expect(render("read")).toEqual(["wrapped", "resolver"]);
		expect(render("mcp__docs__search")).toEqual(["wrapped", "unregistered"]);
		expect(harness.session.getToolRenderers("unknown")).toBeUndefined();
		const htmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) => harness!.session.getToolRenderers(name),
			theme: {} as never,
			cwd: harness.tempDir,
			width: 80,
		});
		expect(htmlRenderer.renderCall("mcp-call", "mcp__docs__search", {})).toContain("unregistered");
		expect(calls).toEqual(["read", "mcp__docs__search", "mcp__docs__search"]);
		api!.registerTool({
			name: "mcp__docs__search",
			label: "Docs",
			description: "Search",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "executed" }], details: undefined }),
			renderCall: () => ({ render: () => ["registered"], invalidate: () => {} }),
		});
		expect(render("mcp__docs__search")).toEqual(["wrapped", "registered"]);
		api!.registerToolRendererWrapper((_tool, renderers) => ({ ...renderers, renderShell: "self" }));
		expect(render("mcp__docs__search")).toEqual(["wrapped", "registered"]);
		expect(render("read")).toEqual(["wrapped", "resolver"]);
		expect(calls).toEqual([
			"read",
			"mcp__docs__search",
			"mcp__docs__search",
			"mcp__docs__search",
			"mcp__docs__search",
			"read",
		]);
		expect(harness.session.getToolRenderers("mcp__docs__search")?.renderShell).toBe("self");
		const executable = harness.session.state.tools.find((tool) => tool.name === "mcp__docs__search");
		expect((await executable?.execute("call", {}, undefined, undefined))?.content).toEqual([
			{ type: "text", text: "executed" },
		]);
	});

	it("clears both renderer collections on reload and rejects stale registrations", async () => {
		let api: ExtensionAPI | undefined;
		let extensionsResult = await createTestExtensionsResult([
			(pi) => {
				api = pi;
				pi.registerToolRenderer(
					(_name, next) =>
						next() ?? {
							renderCall: () => ({ render: () => ["resolved"], invalidate: () => {} }),
						},
				);
				pi.registerToolRendererWrapper((_tool, renderers) => ({ ...renderers, renderShell: "self" }));
			},
		]);
		harness = await createHarness({
			resourceLoader: {
				...createTestResourceLoader(),
				getExtensions: () => extensionsResult,
				reload: async () => {
					extensionsResult = await createTestExtensionsResult([]);
				},
			},
		});
		expect(harness.session.getToolRenderers("foreign")?.renderShell).toBe("self");
		expect(
			harness.session
				.getToolRenderers("foreign")
				?.renderCall?.({}, {} as never, {} as never)
				.render(80),
		).toEqual(["resolved"]);
		await harness.session.reload();
		expect(harness.session.getToolRenderers("foreign")).toBeUndefined();
		expect(harness.session.getToolRenderers("read")?.renderShell).toBe(
			harness.session.getToolDefinition("read")?.renderShell,
		);
		expect(() => api!.registerToolRenderer((_name, next) => next())).toThrow("stale");
		expect(() => api!.registerToolRendererWrapper((_tool, renderers) => renderers)).toThrow("stale");
	});

	it("applies composed renderers to inherited tools without changing execution", async () => {
		const parameters = Type.Object({ value: Type.String() });
		const calls: string[] = [];
		let inheritedRenderer = false;
		harness = await createHarness({
			initialActiveToolNames: ["read"],
			extensionFactories: [
				(pi) => {
					pi.registerToolRendererWrapper((tool, renderers) => {
						if (tool.name !== "read") return renderers;
						inheritedRenderer = typeof renderers.renderCall === "function";
						return {
							...renderers,
							renderCall: () => ({
								render: () => {
									calls.push("first");
									return ["first"];
								},
								invalidate: () => {},
							}),
						};
					});
				},
				(pi) => {
					pi.registerToolRendererWrapper((tool, renderers) => {
						if (tool.name !== "read") return renderers;
						const previous = renderers.renderCall!;
						return {
							...renderers,
							renderCall: (...args) => ({
								render: (width) => {
									calls.push("second");
									return previous(...args).render(width);
								},
								invalidate: () => {},
							}),
						};
					});
					pi.registerTool({
						name: "read",
						label: "Fork read",
						description: "Replacement read implementation",
						parameters,
						execute: async (_id, args) => ({
							content: [{ type: "text", text: args.value }],
							details: undefined,
						}),
					});
				},
			],
		});

		const definition = harness.session.getToolDefinition("read");
		expect(inheritedRenderer).toBe(true);
		expect(definition).toMatchObject({ label: "Fork read", description: "Replacement read implementation" });
		expect(definition?.parameters).toBe(parameters);
		expect(definition?.renderCall?.({ value: "x" }, {} as never, {} as never).render(80)).toEqual(["first"]);
		expect(calls).toEqual(["second", "first"]);

		const htmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) => harness!.session.getToolRenderers(name),
			theme: {} as never,
			cwd: harness.tempDir,
			width: 80,
		});
		expect(htmlRenderer.renderCall("html-call", "read", { value: "x" })).toContain("first");
		expect(calls).toEqual(["second", "first", "second", "first"]);

		const executable = harness.session.state.tools.find((tool) => tool.name === "read");
		const result = await executable?.execute("call", { value: "unchanged" }, undefined, undefined);
		expect(result?.content).toEqual([{ type: "text", text: "unchanged" }]);
	});
});
