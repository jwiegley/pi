import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { buildBundle } from "../../src/modes/interactive/bug-report.ts";
import { createHarness, type Harness } from "./harness.ts";

// Upstream's /bug flow (3c75b2747) counts the session's messages with session.messages.length,
// and its summary reads session.messages. A resumed session holds its transcript as a deferred
// source, and those reads would load the whole active transcript and keep it until the session
// next rebuilds its context. The fork counts with session.messageCount and summarizes a snapshot.
describe("bug reports with bounded history", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	/** Persist a one-turn session, then resume it with a deferred transcript whose loads are counted. */
	async function resume(): Promise<{ harness: Harness; materializations: () => number }> {
		const writer = await createHarness({ persistSession: true });
		cleanups.push(() => writer.cleanup());
		writer.setResponses([fauxAssistantMessage("hello")]);
		await writer.session.prompt("hi");
		writer.sessionManager.flush();
		const sessionFile = writer.sessionManager.getSessionFile()!;
		// Pi exits, which closes the session's store.
		writer.session.dispose();

		const reopened = SessionManager.open(sessionFile, writer.tempDir);
		cleanups.push(() => reopened.close());
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
		// The session installs the reopened session's context as its deferred transcript.
		const harness = await createHarness({ sessionManager: reopened });
		cleanups.push(() => harness.cleanup());
		expect(materializations).toBe(0);
		return { harness, materializations: () => materializations };
	}

	it("builds a resumed session's report without loading its transcript", async () => {
		const { harness, materializations } = await resume();
		// The bundle reads the crash log from the agent directory.
		vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
		const session = harness.session;
		const messageCount = session.messageCount;
		expect(messageCount).toBeGreaterThan(0);

		const bundle = buildBundle(session, { includeSession: true, includeSummary: false, delivery: "zip" }, undefined);
		expect(materializations()).toBe(0);
		expect(bundle.metadata.session.messageCount).toBe(messageCount);

		// Reading the transcript itself loads it once, with as many messages as the report counted.
		expect(session.messages).toHaveLength(messageCount);
		expect(materializations()).toBe(1);
	});

	it("summarizes a resumed session for a report without keeping its transcript", async () => {
		const { harness, materializations } = await resume();
		const session = harness.session;
		const messageCount = session.messageCount;
		harness.setResponses([fauxAssistantMessage("## What went wrong\n\nThe greeting was too short.")]);

		const summary = await session.summarizeForBugReport({ signal: new AbortController().signal });
		expect(summary).toContain("The greeting was too short.");
		// The summary reads the transcript once.
		expect(materializations()).toBe(1);

		// The transcript is still deferred, so reading it loads it again.
		expect(session.messages).toHaveLength(messageCount);
		expect(materializations()).toBe(2);
	});
});
