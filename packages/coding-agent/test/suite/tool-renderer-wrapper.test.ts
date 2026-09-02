import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../../src/core/export-html/tool-renderer.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("extension tool renderer wrappers", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("applies composed renderers to inherited tools without changing execution", async () => {
		const parameters = Type.Object({ value: Type.String() });
		const calls: string[] = [];
		let inheritedRenderer = false;
		harness = await createHarness({
			initialActiveToolNames: ["read"],
			extensionFactories: [
				(pi) => {
					pi.registerToolRenderer((tool, renderers) => {
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
					pi.registerToolRenderer((tool, renderers) => {
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
			getToolDefinition: () => definition,
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
