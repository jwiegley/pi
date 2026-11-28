import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createHarness, type Harness } from "../harness.ts";

// Providers without an API key of their own, so only their stored credentials configure them.
const providersWithoutKeys = {
	providers: Object.fromEntries(
		["failing-command", "working-command"].map((provider) => [
			provider,
			{ baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: "model" }] },
		]),
	),
};

describe("issue #12164 stored command key auth status", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("reports a stored key whose command fails as stored but not configured", async () => {
		const authStorage = AuthStorage.inMemory({
			"failing-command": { type: "api_key", key: "!exit 1" },
			"working-command": { type: "api_key", key: "!echo key" },
		});
		harness = await createHarness({ withConfiguredAuth: false, modelsJson: providersWithoutKeys, authStorage });
		const runtime = harness.session.modelRuntime;
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getProviderAuthStatus("failing-command")).toEqual({ configured: false, source: "stored" });
		expect(runtime.hasConfiguredAuth("failing-command")).toBe(false);
		expect(runtime.getProviderAuthStatus("working-command")).toEqual({ configured: true, source: "stored" });
		expect(runtime.hasConfiguredAuth("working-command")).toBe(true);
	});
});
