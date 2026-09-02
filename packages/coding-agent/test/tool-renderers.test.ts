import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { applyToolRendererWrappers } from "../src/core/extensions/tool-renderers.ts";
import type {
	Extension,
	StockToolRenderers,
	ToolDefinition,
	ToolRendererWrapper,
} from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function extension(path: string, toolRenderers: ToolRendererWrapper[]): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: createSyntheticSourceInfo(path, { source: "test" }),
		handlers: new Map(),
		tools: new Map(),
		toolRenderers,
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function definition(name = "edit"): ToolDefinition {
	return {
		name,
		label: name,
		description: "test tool",
		promptSnippet: "Test tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "unchanged" }], details: undefined }),
	};
}

describe("applyToolRendererWrappers", () => {
	it("composes wrappers in extension order and only changes renderer fields", () => {
		const execute = vi.fn(definition().execute);
		const originalCall: NonNullable<ToolDefinition["renderCall"]> = () => ({
			render: () => ["original"],
			invalidate: () => {},
		});
		const originalResult: NonNullable<ToolDefinition["renderResult"]> = () => ({
			render: () => ["result"],
			invalidate: () => {},
		});
		const inherited = {
			...definition(),
			renderShell: "self" as const,
			renderCall: originalCall,
			renderResult: originalResult,
		};
		const tool = { ...definition(), execute };
		const order: string[] = [];
		const errors: string[] = [];
		const replacementExecute = vi.fn();

		const wrapped = applyToolRendererWrappers(
			[
				extension("first", [
					(_info, renderers) => {
						order.push(`first:${renderers.renderShell}`);
						const previous = renderers.renderCall!;
						return {
							renderCall: (...args) => {
								order.push("first-call");
								return previous(...args);
							},
						};
					},
				]),
				extension("throwing", [
					() => {
						throw new Error("renderer boom");
					},
				]),
				extension("invalid", [() => null as unknown as StockToolRenderers]),
				extension("last", [
					(_info, renderers) => {
						const previous = renderers.renderCall!;
						return {
							renderShell: "default",
							renderCall: (...args: Parameters<NonNullable<ToolDefinition["renderCall"]>>) => {
								order.push("last-call");
								return previous(...args);
							},
							execute: replacementExecute,
						} as unknown as StockToolRenderers;
					},
				]),
			],
			tool,
			inherited,
			(error) => errors.push(`${error.extensionPath}:${error.event}:${error.error}`),
		);

		expect(wrapped.execute).toBe(execute);
		expect(wrapped.parameters).toBe(tool.parameters);
		expect(wrapped.description).toBe(tool.description);
		expect(wrapped.promptSnippet).toBe(tool.promptSnippet);
		expect(wrapped.renderShell).toBe("default");
		expect(wrapped.renderResult).toBe(originalResult);
		expect(tool).not.toHaveProperty("renderCall");
		expect(wrapped.renderCall?.({}, {} as never, {} as never).render(80)).toEqual(["original"]);
		expect(order).toEqual(["first:self", "last-call", "first-call"]);
		expect(errors).toEqual([
			"throwing:tool_renderer:renderer boom",
			"invalid:tool_renderer:Tool renderer wrapper must return a renderer object",
		]);
	});

	it("supports foreign tools without inherited renderers", () => {
		const wrapped = applyToolRendererWrappers(
			[extension("generic", [() => ({ renderCall: () => ({ render: () => ["foreign"], invalidate: () => {} }) })])],
			definition("mcp_foreign"),
		);

		expect(wrapped.renderCall?.({}, {} as never, {} as never).render(80)).toEqual(["foreign"]);
	});
});
