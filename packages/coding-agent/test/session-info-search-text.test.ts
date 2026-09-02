import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";

const FIRST_MESSAGE_LIMIT = 4 * 1024;
const SEARCH_TEXT_LIMIT = 64 * 1024;

describe("SessionInfo search text", () => {
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "pi-session-info-search-"));
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("bounds retained text while scanning later entries for metadata", async () => {
		const firstUserMessage = `first-user-${"u".repeat(FIRST_MESSAGE_LIMIT)}`;
		const latestActivity = Date.parse("2026-01-01T00:04:00.000Z");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "bounded-search",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/bounded/project",
			},
			{
				type: "message",
				id: "assistant-before-user",
				parentId: null,
				timestamp: "2026-01-01T00:01:00.000Z",
				message: {
					role: "assistant",
					content: "a".repeat(SEARCH_TEXT_LIMIT),
					timestamp: Date.parse("2026-01-01T00:01:00.000Z"),
				},
			},
			{
				type: "message",
				id: "first-user",
				parentId: "assistant-before-user",
				timestamp: "2026-01-01T00:02:00.000Z",
				message: { role: "user", content: firstUserMessage, timestamp: Date.parse("2026-01-01T00:02:00.000Z") },
			},
			{
				type: "session_info",
				id: "old-name",
				parentId: "first-user",
				timestamp: "2026-01-01T00:02:30.000Z",
				name: "Old Name",
			},
			{
				type: "message",
				id: "tool-result",
				parentId: "old-name",
				timestamp: "2026-01-01T00:03:00.000Z",
				message: { role: "toolResult", content: "counted but not searchable" },
			},
			{
				type: "message",
				id: "latest-assistant",
				parentId: "tool-result",
				timestamp: "2026-01-01T00:04:00.000Z",
				message: { role: "assistant", content: "needle-after-cap", timestamp: latestActivity },
			},
			{
				type: "session_info",
				id: "latest-name",
				parentId: "latest-assistant",
				timestamp: "2026-01-01T00:05:00.000Z",
				name: "Latest Session Name",
			},
		];
		writeFileSync(join(sessionDir, "bounded.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const [session] = await SessionManager.listAll(sessionDir);

		expect(session).toBeDefined();
		expect(session.messageCount).toBe(4);
		expect(session.name).toBe("Latest Session Name");
		expect(session.modified.getTime()).toBe(latestActivity);
		expect(session.firstMessage).toBe(firstUserMessage.slice(0, FIRST_MESSAGE_LIMIT));
		expect(session.firstMessageTruncated).toBe(true);
		expect(session.allMessagesText).toBe("a".repeat(SEARCH_TEXT_LIMIT));
		expect(Buffer.byteLength(session.allMessagesText)).toBe(SEARCH_TEXT_LIMIT);
		expect(session.allMessagesTextTruncated).toBe(true);
		expect(filterAndSortSessions([session], '"latest session name"', "recent")).toEqual([session]);
		expect(filterAndSortSessions([session], "first-user", "recent")).toEqual([session]);
		expect(filterAndSortSessions([session], "needle-after-cap", "recent")).toEqual([]);
	});
});
