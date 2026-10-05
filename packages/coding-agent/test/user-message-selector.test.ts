import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

describe("UserMessageSelectorComponent", () => {
	test("renders the truncation notice and preview marker", () => {
		const notice = "Showing the most recent 128 user messages; older messages are omitted.";
		const selector = new UserMessageSelectorComponent(
			[{ id: "user-1", text: "bounded preview", textTruncated: true }],
			() => {},
			() => {},
			undefined,
			notice,
		);

		const plain = selector.render(100).map(stripVTControlCharacters).join("\n");
		expect(plain).toContain(notice);
		expect(plain).toContain("bounded preview … [preview truncated]");
	});
});
