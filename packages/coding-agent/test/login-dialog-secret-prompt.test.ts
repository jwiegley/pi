import type { AuthPrompt } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const showAuthPrompt = Reflect.get(InteractiveMode.prototype, "showAuthPrompt") as (
	this: object,
	dialog: LoginDialogComponent,
	prompt: AuthPrompt,
	providerId: string,
) => Promise<string>;

const SECRET = "sk-QZ9$HOME!x7QZ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const KILL_TO_LINE_START = "\x15";
const YANK = "\x19";
const UNDO = "\x1b[45;5u";

/** A focused dialog whose every render is kept, as the terminal would have drawn it. */
function createDialog() {
	const dialog = new LoginDialogComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		"secret-provider",
		() => {},
		"Secret Provider",
	);
	dialog.focused = true;
	const frames: string[] = [];
	const draw = () => {
		// stripAnsi keeps APC sequences, so drop the TUI's zero-width cursor markers first.
		frames.push(
			stripAnsi(
				dialog
					.render(120)
					.join("\n")
					.replace(/\x1b_[^\x07]*\x07/g, ""),
			),
		);
	};
	const type = (data: string) => {
		dialog.handleInput(data);
		draw();
	};
	return { dialog, frames, draw, type };
}

function ask(dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
	return showAuthPrompt.call({}, dialog, prompt, "secret-provider");
}

/** Every four-character run of `secret` the frames show; any one would put part of the key on screen. */
function shownParts(frames: readonly string[], secret: string): string[] {
	const parts = new Set<string>();
	for (let index = 0; index + 4 <= secret.length; index++) {
		const part = secret.slice(index, index + 4);
		if (frames.some((frame) => frame.includes(part))) parts.add(part);
	}
	return [...parts];
}

describe("login dialog secret prompts", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	test("never draws a typed secret, while typing or after submitting", async () => {
		const { dialog, frames, draw, type } = createDialog();
		const response = ask(dialog, { type: "secret", message: "Enter Secret Provider API key" });
		draw();
		for (const character of SECRET) type(character);
		type("\r");

		await expect(response).resolves.toBe(SECRET);
		expect(shownParts(frames, SECRET)).toEqual([]);
		expect(frames.at(-1)).toContain("Enter Secret Provider API key");
	});

	test("never draws a pasted secret, while pasting or after submitting", async () => {
		const { dialog, frames, draw, type } = createDialog();
		const response = ask(dialog, { type: "secret", message: "Enter Secret Provider API key" });
		draw();
		type(`${PASTE_START}${SECRET}`);
		type(PASTE_END);
		type("\r");

		await expect(response).resolves.toBe(SECRET);
		expect(shownParts(frames, SECRET)).toEqual([]);
	});

	test("still echoes a text prompt's value", async () => {
		const { dialog, frames, draw, type } = createDialog();
		const response = ask(dialog, { type: "text", message: "Enter account ID" });
		draw();
		for (const character of "acct-4821") type(character);
		expect(frames.at(-1)).toContain("> acct-4821");
		type("\r");

		await expect(response).resolves.toBe("acct-4821");
		expect(frames.at(-1)).toContain("> acct-4821");
	});

	test("a later prompt cannot bring back a secret through undo or yank", async () => {
		const { dialog, frames, draw, type } = createDialog();
		const secret = ask(dialog, { type: "secret", message: "Enter Secret Provider API key" });
		draw();
		type(SECRET);
		type(KILL_TO_LINE_START);
		type(SECRET);
		type("\r");
		await expect(secret).resolves.toBe(SECRET);

		const yanked = ask(dialog, { type: "text", message: "Enter account ID" });
		draw();
		type(YANK);
		type("\r");
		await expect(yanked).resolves.toBe("");

		const undone = ask(dialog, { type: "text", message: "Enter region" });
		draw();
		type(UNDO);
		type("\r");
		await expect(undone).resolves.toBe("");

		expect(shownParts(frames, SECRET)).toEqual([]);
	});
});
