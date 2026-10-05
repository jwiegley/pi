import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createHttpIdleTimeoutFetch } from "../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeModelsJson(provider: object): string {
	const root = mkdtempSync(join(tmpdir(), "pi-provider-transport-"));
	roots.push(root);
	const path = join(root, "models.json");
	writeFileSync(path, JSON.stringify({ providers: { test: provider } }));
	return path;
}

async function createRuntime(provider: object): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: writeModelsJson(provider),
		refreshOnCreate: false,
	});
}

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}`;
}

describe("provider transport settings", () => {
	it("accepts transport-only providers and projects request and idle timeouts", async () => {
		const runtime = await createRuntime({ transport: { requestTimeoutMs: 1234, idleTimeoutMs: 0 } });

		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getProviderTransportOptions("test")).toMatchObject({
			timeoutMs: 1234,
			fetch: expect.any(Function),
		});
		expect(runtime.getProviderTransportOptions("missing")).toEqual({});
	});

	it.each([
		{ requestTimeoutMs: 0 },
		{ requestTimeoutMs: 2147483648 },
		{ idleTimeoutMs: -1 },
		{ idleTimeoutMs: 2147483648 },
	])("rejects invalid transport bounds: %j", async (transport) => {
		const runtime = await createRuntime({ transport });

		expect(runtime.getProviderTransportOptions("test")).toEqual({});
		expect(runtime.getError()).toContain("Invalid models.json schema");
	});

	it("keeps a delayed response body alive when idle timeout is disabled", async () => {
		const url = await listen(
			createServer((_request, response) => {
				response.writeHead(200, { "content-type": "text/plain" });
				response.write("first");
				setTimeout(() => response.end("-last"), 40);
			}),
		);

		const response = await createHttpIdleTimeoutFetch(0)(url);
		await expect(response.text()).resolves.toBe("first-last");
	});
});
