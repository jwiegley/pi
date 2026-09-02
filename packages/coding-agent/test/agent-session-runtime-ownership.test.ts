import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";

function createManager(overrides: Partial<SessionManager> = {}): SessionManager {
	return {
		close: vi.fn(),
		createBranchedSession: vi.fn(() => "/tmp/forked.jsonl"),
		getCwd: vi.fn(() => process.cwd()),
		getSessionFile: vi.fn(() => "/tmp/candidate.jsonl"),
		...overrides,
	} as unknown as SessionManager;
}

function createSession(sessionManager: SessionManager, sessionFile = "/tmp/current.jsonl"): AgentSession {
	return {
		abort: vi.fn(async () => {}),
		createReplacedSessionContext: vi.fn(() => ({})),
		dispose: vi.fn(),
		extensionRunner: { hasHandlers: vi.fn(() => false) },
		sessionFile,
		sessionManager,
	} as unknown as AgentSession;
}

function createServices(cwd = process.cwd()): AgentSessionServices {
	return { agentDir: cwd, cwd } as AgentSessionServices;
}

function createResult(sessionManager: SessionManager): CreateAgentSessionRuntimeResult {
	return {
		diagnostics: [],
		extensionsResult: {},
		services: createServices(sessionManager.getCwd()),
		session: createSession(sessionManager, sessionManager.getSessionFile()),
	} as unknown as CreateAgentSessionRuntimeResult;
}

describe("AgentSessionRuntime SessionManager ownership", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("closes a pending switch manager when runtime creation fails", async () => {
		const currentManager = createManager();
		const candidateManager = createManager();
		vi.spyOn(SessionManager, "open").mockReturnValue(candidateManager);
		const createRuntime = vi.fn(async () => {
			throw new Error("creation failed");
		}) as CreateAgentSessionRuntimeFactory;
		const runtime = new AgentSessionRuntime(createSession(currentManager), createServices(), createRuntime);

		await expect(runtime.switchSession("/tmp/candidate.jsonl")).rejects.toThrow("creation failed");

		expect(candidateManager.close).toHaveBeenCalledOnce();
	});

	it("does not close a switch manager after the replacement runtime adopts it", async () => {
		const currentManager = createManager();
		const candidateManager = createManager();
		vi.spyOn(SessionManager, "open").mockReturnValue(candidateManager);
		const replacement = createResult(candidateManager);
		const createRuntime = vi.fn(async () => replacement) as CreateAgentSessionRuntimeFactory;
		const runtime = new AgentSessionRuntime(createSession(currentManager), createServices(), createRuntime);
		runtime.setRebindSession(async () => {
			throw new Error("rebind failed");
		});

		await expect(runtime.switchSession("/tmp/candidate.jsonl")).rejects.toThrow("rebind failed");

		expect(runtime.session).toBe(replacement.session);
		expect(candidateManager.close).not.toHaveBeenCalled();
	});

	it("closes a pending persisted-fork manager when runtime creation fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-ownership-fork-"));
		cleanupPaths.push(tempDir);
		const currentSessionFile = join(tempDir, "current.jsonl");
		writeFileSync(currentSessionFile, "");
		const currentManager = createManager({
			getEntry: vi.fn(
				(): SessionEntry => ({
					id: "leaf",
					parentId: null,
					thinkingLevel: "off",
					timestamp: new Date().toISOString(),
					type: "thinking_level_change",
				}),
			),
			getSessionDir: vi.fn(() => tempDir),
			isPersisted: vi.fn(() => true),
		});
		const candidateManager = createManager();
		vi.spyOn(SessionManager, "open").mockReturnValue(candidateManager);
		const createRuntime = vi.fn(async () => {
			throw new Error("creation failed");
		}) as CreateAgentSessionRuntimeFactory;
		const runtime = new AgentSessionRuntime(
			createSession(currentManager, currentSessionFile),
			createServices(),
			createRuntime,
		);

		await expect(runtime.fork("leaf", { position: "at" })).rejects.toThrow("creation failed");

		expect(candidateManager.close).toHaveBeenCalledOnce();
	});

	it("closes a pending import manager when runtime creation fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-ownership-import-"));
		cleanupPaths.push(tempDir);
		const inputPath = join(tempDir, "import.jsonl");
		writeFileSync(inputPath, "");
		const currentManager = createManager({ getSessionDir: vi.fn(() => tempDir) });
		const candidateManager = createManager();
		vi.spyOn(SessionManager, "open").mockReturnValue(candidateManager);
		const createRuntime = vi.fn(async () => {
			throw new Error("creation failed");
		}) as CreateAgentSessionRuntimeFactory;
		const runtime = new AgentSessionRuntime(createSession(currentManager), createServices(), createRuntime);

		await expect(runtime.importFromJsonl(inputPath)).rejects.toThrow("creation failed");

		expect(candidateManager.close).toHaveBeenCalledOnce();
	});
});
