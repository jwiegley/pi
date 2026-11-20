import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession, type InlineExtension } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

function extensionTool(name: string, defaultActive = true) {
	return {
		name,
		label: name,
		description: `Extension tool ${name}`,
		parameters: Type.Object({}),
		defaultActive,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	};
}

/** Tools the session records: it removes removed_tool and later activates inactive_tool. */
const sessionTools: InlineExtension = (pi) => {
	pi.registerTool(extensionTool("removed_tool"));
	pi.registerTool(extensionTool("inactive_tool", false));
};

/** An extension installed after the session recorded its loadout. */
const lateTools: InlineExtension = (pi) => {
	pi.registerTool(extensionTool("late_tool"));
};

// Upstream restores the loadout on resume and tree navigation from every system message on the
// branch (bd3c9b823, #11062), so tools removed before a compaction stay inactive and extension tools
// registered later are activated. The fork reads those messages from the indexed store with
// getBranchSystemMessages() instead of hydrating the branch with getBranch().
describe("tool restore with bounded history", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("restores a reopened session's loadout across a compaction without hydrating its branch", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialActiveToolNames: BUILTIN_TOOLS,
			extensionFactories: [sessionTools],
		});
		harnesses.push(harness);
		const run = async (text: string) => {
			harness.setResponses([fauxAssistantMessage(text)]);
			await harness.session.prompt(text);
		};

		// The first run records the loadout, the second records removing removed_tool.
		await run("one");
		harness.session.setActiveToolsByName(BUILTIN_TOOLS);
		await run("two");
		// Compact so that the removal is summarized: it is recorded before the kept user message.
		const entries = harness.sessionManager.getEntries();
		const keptIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === "two",
		);
		const removalIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "system" &&
				entry.message.toolsRemoved?.some((tool) => tool.name === "removed_tool"),
		);
		expect(removalIndex).toBeGreaterThanOrEqual(0);
		expect(removalIndex).toBeLessThan(keptIndex);
		const compactionId = harness.sessionManager.appendCompaction("summary", entries[keptIndex]!.id, 100);
		harness.session.refreshContext();
		// After the compaction, the third run records activating inactive_tool.
		harness.session.setActiveToolsByName([...BUILTIN_TOOLS, "inactive_tool"]);
		await run("three");
		harness.sessionManager.flush();
		const sessionFile = harness.sessionManager.getSessionFile()!;
		// Pi exits, which closes the session's store.
		harness.session.dispose();

		const reopened = SessionManager.open(sessionFile, harness.tempDir);
		const getBranch = vi.spyOn(reopened, "getBranch").mockImplementation(() => {
			throw new Error("restoring tools must not hydrate the branch");
		});
		const getEntries = vi.spyOn(reopened, "getEntries").mockImplementation(() => {
			throw new Error("restoring tools must not hydrate the history");
		});
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: harness.tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [sessionTools, lateTools],
		});
		await resourceLoader.reload();
		let session: AgentSession | undefined;
		try {
			// Resume with the default tools, which restores the recorded loadout.
			({ session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: reopened,
				resourceLoader,
			}));
			expect(session.getActiveToolNames().sort()).toEqual([
				"bash",
				"edit",
				"inactive_tool",
				"late_tool",
				"read",
				"write",
			]);

			// The compaction's branch never activated inactive_tool.
			await session.navigateTree(compactionId, { summarize: false });
			expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "late_tool", "read", "write"]);
			// Check before mockRestore(), which clears the recorded calls.
			expect(getBranch).not.toHaveBeenCalled();
			expect(getEntries).not.toHaveBeenCalled();
		} finally {
			getBranch.mockRestore();
			getEntries.mockRestore();
			session?.dispose();
			reopened.close();
		}
	});
});
