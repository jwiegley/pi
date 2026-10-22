import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "../src/types.ts";

// GLM-5.3-Flash on oMLX returned this call: the shell command stood where the tool name belongs.
const MALFORMED_NAME = `ssh -o BatchMode=yes -o ConnectTimeout=10 athena 'cd /etc/nixos && git status --short | head -5; git log --oneline -2; sed -n "60,80p" modules/users/home-manager/default.nix' 2>&1</arg_value>`;

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function glmToolCall(id: string, name: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { timeout: 30 } }],
		api: "openai-completions",
		provider: "omlx-hera",
		model: "GLM-5.3-Flash-oQ4e-mtp",
		usage,
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, name: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: `Tool ${name} not found` }],
		isError: true,
		timestamp,
	};
}

function replayedCalls(names: string[]): { call_id: string; name: string }[] {
	const messages: Message[] = [{ role: "user", content: "Check athena.", timestamp: 1 }];
	names.forEach((name, index) => {
		messages.push(
			glmToolCall(`call_${index}`, name, 2 + 2 * index),
			toolResult(`call_${index}`, name, 3 + 2 * index),
		);
	});
	const model = getModel("openai-codex", "gpt-5.5");
	const context = normalizeContext({ systemPrompt: "You are concise.", messages });
	const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
	const outputs = input.flatMap((item) => (item.type === "function_call_output" ? [item.call_id] : []));
	expect(outputs).toEqual(names.map((_, index) => `call_${index}`));
	return input.flatMap((item) => (item.type === "function_call" ? [{ call_id: item.call_id, name: item.name }] : []));
}

describe("OpenAI Responses foreign tool call name normalization", () => {
	it("replays a malformed foreign name as the placeholder Codex Compat sends", () => {
		expect(MALFORMED_NAME).toHaveLength(191);
		expect(replayedCalls([MALFORMED_NAME, "read"])).toEqual([
			{ call_id: "call_0", name: "invalid_tool_name_vfexntyirncz" },
			{ call_id: "call_1", name: "read" },
		]);
	});

	it("keeps names Responses accepts and replaces the rest", () => {
		const longest = "a".repeat(128);
		const [kept, tooLong, badCharacter, empty] = replayedCalls([longest, `${longest}a`, "mcp:server:tool", ""]);
		expect(kept?.name).toBe(longest);
		for (const call of [tooLong, badCharacter, empty]) {
			expect(call?.name).toMatch(/^invalid_tool_name_[a-z0-9]+$/);
		}
		expect(new Set([tooLong?.name, badCharacter?.name, empty?.name]).size).toBe(3);
	});
});
