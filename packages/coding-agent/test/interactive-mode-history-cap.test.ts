import { Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const TRUNCATION_NOTICE = "History truncated: showing the most recent 128 session entries; older entries are omitted.";

type TestContext = {
	chatContainer: Container;
	renderSessionEntries: ReturnType<typeof vi.fn>;
};

function asInteractiveMode(context: TestContext): InteractiveMode {
	return context as unknown as InteractiveMode;
}

function createContext(activeEntries: number | (() => number), persisted = true): TestContext {
	const getActiveEntries = typeof activeEntries === "function" ? activeEntries : () => activeEntries;
	const getRecentActiveEntries = vi.fn(() => []);
	return Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		chatContainer: new Container(),
		runtimeHost: {
			session: {
				settingsManager: { getShowTerminalProgress: () => false },
				sessionManager: {
					getHistoryMetrics: () => (persisted ? { session_active_entries: getActiveEntries() } : undefined),
					getActiveBranchMetadata: () => Array.from({ length: getActiveEntries() }, () => ({})),
					getRecentActiveEntries,
					buildContextEntries: vi.fn(() => Array.from({ length: getActiveEntries() }, () => ({}))),
					getCwd: () => process.cwd(),
					getHistorySummary: () => ({ compactionCount: 0 }),
				},
			},
		},
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		pendingTools: new Map(),
		clearStatusIndicator: vi.fn(),
		renderSessionEntries: vi.fn(),
		renderProjectTrustWarningIfNeeded: vi.fn(),
		showStatus: vi.fn(),
	}) as TestContext;
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(160).join("\n"));
}

describe("InteractiveMode rendered session history cap", () => {
	beforeAll(() => initTheme("dark"));

	test.each([
		["initial", 129, true],
		["initial", 128, false],
		["rebuild", 129, true],
		["rebuild", 128, false],
	] as const)("%s render shows the notice only when history is truncated", (path, activeEntries, truncated) => {
		const context = createContext(activeEntries);

		if (path === "initial") {
			InteractiveMode.prototype.renderInitialMessages.call(asInteractiveMode(context));
		} else {
			context.chatContainer.addChild(new Text("stale chat", 0, 0));
			const rebuild = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
				this: InteractiveMode,
			) => void;
			rebuild.call(asInteractiveMode(context));
		}

		expect(renderChat(context.chatContainer).includes(TRUNCATION_NOTICE)).toBe(truncated);
	});

	test("in-memory history uses the same cap", () => {
		const context = createContext(129, false);
		InteractiveMode.prototype.renderInitialMessages.call(asInteractiveMode(context));
		expect(renderChat(context.chatContainer)).toContain(TRUNCATION_NOTICE);
	});

	test("in-memory cap counts compaction-aware renderable entries, not raw ancestry", () => {
		const context = createContext(2, false);
		const runtimeHost = Reflect.get(context, "runtimeHost") as {
			session: { sessionManager: { getActiveBranchMetadata: () => unknown[] } };
		};
		runtimeHost.session.sessionManager.getActiveBranchMetadata = () => Array.from({ length: 1000 }, () => ({}));
		InteractiveMode.prototype.renderInitialMessages.call(asInteractiveMode(context));
		expect(renderChat(context.chatContainer)).not.toContain(TRUNCATION_NOTICE);
	});

	test("truncated rendering preserves context order around the latest compaction", () => {
		const manager = SessionManager.inMemory();
		const ids = Array.from({ length: 130 }, (_, index) => manager.appendCustomEntry("test", index));
		manager.appendCompaction("summary", ids[0]!, 1000);
		const expected = manager.buildContextEntries().slice(-128);
		const context = createContext(0, false);
		const runtimeHost = Reflect.get(context, "runtimeHost") as {
			session: { sessionManager: SessionManager };
		};
		runtimeHost.session.sessionManager = manager;

		InteractiveMode.prototype.renderInitialMessages.call(asInteractiveMode(context));
		expect(context.renderSessionEntries.mock.calls[0]?.[0]).toEqual(expected);
	});

	test("completed live turns are rebuilt into a bounded view and keep the notice", async () => {
		const context = createContext(129, false);
		for (let index = 0; index < 300; index++) context.chatContainer.addChild(new Text(`live-${index}`, 0, 0));
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: InteractiveMode,
			event: { type: "agent_end" },
		) => Promise<void>;

		await handleEvent.call(asInteractiveMode(context), { type: "agent_end" });
		expect(context.chatContainer.children).toHaveLength(2);
		expect(renderChat(context.chatContainer)).toContain(TRUNCATION_NOTICE);

		context.chatContainer.addChild(new Text("next live turn", 0, 0));
		await handleEvent.call(asInteractiveMode(context), { type: "agent_end" });
		expect(context.chatContainer.children).toHaveLength(2);
		expect(renderChat(context.chatContainer)).toContain(TRUNCATION_NOTICE);
	});

	test("completed idle bash entries cannot grow an already full live chat", async () => {
		let activeEntries = 128;
		const context = createContext(() => activeEntries, false);
		for (let index = 0; index < 300; index++) context.chatContainer.addChild(new Text(`live-${index}`, 0, 0));
		const recordBashResult = vi.fn(() => {
			activeEntries++;
		});
		const runtimeHost = Reflect.get(context, "runtimeHost") as {
			session: {
				isStreaming: boolean;
				extensionRunner: { emitUserBash: ReturnType<typeof vi.fn> };
				recordBashResult: ReturnType<typeof vi.fn>;
			};
		};
		Object.assign(runtimeHost.session, {
			isStreaming: false,
			extensionRunner: {
				emitUserBash: vi.fn(async () => ({
					result: { output: "ok", exitCode: 0, cancelled: false, truncated: false },
				})),
			},
			recordBashResult,
		});
		const handleBashCommand = Reflect.get(InteractiveMode.prototype, "handleBashCommand") as (
			this: InteractiveMode,
			command: string,
		) => Promise<void>;

		await handleBashCommand.call(asInteractiveMode(context), "true");
		expect(recordBashResult).toHaveBeenCalledOnce();
		expect(context.chatContainer.children).toHaveLength(2);
		expect(renderChat(context.chatContainer)).toContain(TRUNCATION_NOTICE);
	});

	test("reports asynchronous paging failures from both navigation selectors", async () => {
		const showError = vi.fn();
		const pagingError = new Error("paging failed");
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				session: {
					getUserMessagesForForkingPage: vi.fn(async () => {
						throw pagingError;
					}),
					sessionManager: {
						getLeafId: () => null,
						getHistorySummary: () => ({ entryCount: 0 }),
						getTreePage: vi.fn(async () => {
							throw pagingError;
						}),
					},
					settingsManager: { getTreeFilterMode: () => "all" },
				},
			},
			showError,
		}) as InteractiveMode;
		const showFork = Reflect.get(InteractiveMode.prototype, "showUserMessageSelector") as (
			this: InteractiveMode,
		) => Promise<void>;
		const showTree = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (
			this: InteractiveMode,
		) => Promise<void>;

		await showFork.call(context);
		await showTree.call(context);
		expect(showError).toHaveBeenNthCalledWith(1, "paging failed");
		expect(showError).toHaveBeenNthCalledWith(2, "paging failed");
	});
});
