import type { Extension, ExtensionError, StockToolRenderers, ToolDefinition } from "./types.ts";

/** Apply registered renderer wrappers without changing tool execution semantics. */
export function applyToolRendererWrappers<T extends ToolDefinition>(
	extensions: readonly Extension[],
	definition: T,
	inheritedDefinition?: ToolDefinition,
	onError: (error: ExtensionError) => void = () => {},
): T {
	let renderers: StockToolRenderers = {
		renderShell: definition.renderShell ?? inheritedDefinition?.renderShell,
		renderCall: definition.renderCall ?? inheritedDefinition?.renderCall,
		renderResult: definition.renderResult ?? inheritedDefinition?.renderResult,
	};
	const tool = { name: definition.name, label: definition.label };

	for (const extension of extensions) {
		for (const wrapper of extension.toolRenderers) {
			try {
				const wrapped = wrapper(tool, { ...renderers });
				if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) {
					throw new TypeError("Tool renderer wrapper must return a renderer object");
				}
				renderers = {
					renderShell: Object.hasOwn(wrapped, "renderShell") ? wrapped.renderShell : renderers.renderShell,
					renderCall: Object.hasOwn(wrapped, "renderCall") ? wrapped.renderCall : renderers.renderCall,
					renderResult: Object.hasOwn(wrapped, "renderResult") ? wrapped.renderResult : renderers.renderResult,
				};
			} catch (error) {
				onError({
					extensionPath: extension.path,
					event: "tool_renderer",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}

	return { ...definition, ...renderers };
}
