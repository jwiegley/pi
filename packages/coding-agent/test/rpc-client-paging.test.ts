import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient paging", () => {
	it("sends paging options and extracts a fork-message page", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const page = {
			messages: [{ entryId: "message-3", text: "third" }],
			nextOrdinal: 3,
		};
		const send = vi.fn(async () => ({ data: page }));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		const result = await client.getForkMessagesPage({ afterOrdinal: 1, direction: "forward", limit: 2 });

		expect(send).toHaveBeenCalledWith({
			type: "get_fork_messages_page",
			afterOrdinal: 1,
			direction: "forward",
			limit: 2,
		});
		expect(result).toEqual(page);
	});

	it("sends paging options and extracts a terminal tree page", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const page = {
			entries: [{ ordinal: 4, id: "entry-4", parentId: null, type: "custom", timestamp: "2026-01-01" }],
			nextOrdinal: null,
			leafId: "entry-4",
		};
		const send = vi.fn(async () => ({ data: page }));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		const result = await client.getTreePage({ beforeOrdinal: 5, direction: "reverse", limit: 1 });

		expect(send).toHaveBeenCalledWith({
			type: "get_tree_page",
			beforeOrdinal: 5,
			direction: "reverse",
			limit: 1,
		});
		expect(result).toEqual(page);
	});

	it.each([
		["fork", "get_fork_messages", "get_fork_messages_page"],
		["tree", "get_tree", "get_tree_page"],
	] as const)("does not allow widened %s page options to override the bounded command", async (kind, legacy, page) => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			data: kind === "fork" ? { messages: [], nextOrdinal: null } : { entries: [] },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;
		const widenedOptions: { type: string; limit: number } = { type: legacy, limit: 1 };

		if (kind === "fork") await client.getForkMessagesPage(widenedOptions);
		else await client.getTreePage(widenedOptions);

		expect(send).toHaveBeenCalledWith({ type: page, limit: 1 });
	});

	it("preserves the legacy raw fork-message request and full-text response", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const messages = [{ entryId: "message-1", text: "x".repeat(5000) }];
		const send = vi.fn(async () => ({ data: { messages } }));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		await expect(client.getForkMessages()).resolves.toEqual(messages);
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith({ type: "get_fork_messages" });
	});

	it("preserves the legacy raw tree request and response", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const data = {
			tree: [
				{
					entry: { type: "custom", id: "entry-1", parentId: null, timestamp: "2026-01-01", customType: "x" },
					children: [],
				},
			],
			leafId: "entry-1",
		};
		const send = vi.fn(async () => ({ data }));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		await expect(client.getTree()).resolves.toEqual(data);
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith({ type: "get_tree" });
	});
});
