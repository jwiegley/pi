import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { Extension, SourceInfo } from "../../src/core/extensions/index.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getSourcePackageKey } from "../../src/core/source-info.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

type ExtensionChangelogUpdate = { name: string; version: string; markdown: string };

/** The InteractiveMode state that the startup changelog checks read. */
type StartupContext = {
	session: AgentSession;
	settingsManager: SettingsManager;
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

const prototype = InteractiveMode.prototype as unknown as {
	getChangelogForDisplay(this: StartupContext): string | undefined;
	getExtensionChangelogUpdates(this: StartupContext): ExtensionChangelogUpdate[];
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

/** Install an extension package at 1.2.0 whose changelog has entries newer than 1.0.0. */
function writeExtensionPackage(dir: string): SourceInfo {
	const packageRoot = join(dir, "pi-demo-extension");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-demo-extension", version: "1.2.0" }));
	writeFileSync(
		join(packageRoot, "CHANGELOG.md"),
		"# Changelog\n\n## [1.2.0]\n\n- Added feature B\n\n## [1.1.0]\n\n- Added feature A\n\n## [1.0.0]\n\n- Initial release\n",
	);
	return {
		path: join(packageRoot, "index.ts"),
		source: "npm:pi-demo-extension",
		scope: "user",
		origin: "package",
		baseDir: packageRoot,
		changelogPath: join(packageRoot, "CHANGELOG.md"),
	};
}

/** Create the session as pi does before InteractiveMode.init() runs the changelog checks. */
async function startSession(
	cwd: string,
	sessionManager: SessionManager,
	settingsManager: SettingsManager,
): Promise<AgentSession> {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		sessionManager,
	});
	return session;
}

/** Run the checks against the real session, which reports the extension package as loaded. */
function startupContext(
	session: AgentSession,
	settingsManager: SettingsManager,
	sourceInfo: SourceInfo,
): StartupContext {
	const loaded = session.resourceLoader.getExtensions();
	vi.spyOn(session.resourceLoader, "getExtensions").mockReturnValue({
		...loaded,
		extensions: [{ sourceInfo } as Extension],
	});
	return { session, settingsManager, readPackageJson: prototype.readPackageJson };
}

// Upstream's extension changelog check (b4b72a351, #8790) skips resumed sessions by reading
// session.state.messages. A resumed session holds its transcript as a deferred source, and that
// read would load the whole active transcript and keep it until the session next rebuilds its
// context. The fork's checks read the message count instead.
describe("startup changelog checks with bounded history", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("skips a resumed session without loading its transcript", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		harness.sessionManager.flush();
		const sessionFile = harness.sessionManager.getSessionFile()!;
		// Pi exits, which closes the session's store.
		harness.session.dispose();

		const reopened = SessionManager.open(sessionFile, harness.tempDir);
		// Count loads of the deferred transcript that createAgentSession() gives the resumed agent.
		let materializations = 0;
		const buildSource = reopened.buildSessionContextSource.bind(reopened);
		vi.spyOn(reopened, "buildSessionContextSource").mockImplementation((onMessage) => {
			const context = buildSource(onMessage);
			const source = context.messages;
			return {
				...context,
				messages: {
					...source,
					materialize: () => {
						materializations++;
						return source.materialize();
					},
				},
			};
		});
		const sourceInfo = writeExtensionPackage(harness.tempDir);
		const key = getSourcePackageKey(sourceInfo);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setExtensionChangelogVersion(key, "1.0.0");

		let session: AgentSession | undefined;
		try {
			session = await startSession(harness.tempDir, reopened, settingsManager);
			expect(materializations).toBe(0);
			const context = startupContext(session, settingsManager, sourceInfo);
			const messageCount = session.messageCount;
			expect(messageCount).toBeGreaterThan(0);

			expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
			expect(materializations).toBe(0);
			expect(prototype.getExtensionChangelogUpdates.call(context)).toEqual([]);
			expect(materializations).toBe(0);
			// The update stays pending for the next fresh launch.
			expect(settingsManager.getExtensionChangelogVersion(key)).toBe("1.0.0");

			// Reading the transcript itself loads it once, with as many messages as the count reported.
			expect(session.messages).toHaveLength(messageCount);
			expect(materializations).toBe(1);
		} finally {
			session?.dispose();
			reopened.close();
		}
	});

	it("shows extension updates on a fresh launch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sourceInfo = writeExtensionPackage(harness.tempDir);
		const key = getSourcePackageKey(sourceInfo);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setExtensionChangelogVersion(key, "1.0.0");

		const session = await startSession(
			harness.tempDir,
			SessionManager.create(harness.tempDir, harness.tempDir),
			settingsManager,
		);
		try {
			const context = startupContext(session, settingsManager, sourceInfo);
			expect(session.messageCount).toBe(0);

			expect(prototype.getExtensionChangelogUpdates.call(context)).toEqual([
				{
					name: "pi-demo-extension",
					version: "1.2.0",
					markdown:
						"## pi-demo-extension [1.2.0]\n\n- Added feature B\n\n## pi-demo-extension [1.1.0]\n\n- Added feature A",
				},
			]);
			expect(settingsManager.getExtensionChangelogVersion(key)).toBe("1.2.0");
		} finally {
			session.dispose();
		}
	});
});
