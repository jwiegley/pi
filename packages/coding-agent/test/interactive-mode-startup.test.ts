import { describe, expect, it, vi } from "vitest";

const { refreshModelCatalogs } = vi.hoisted(() => ({ refreshModelCatalogs: vi.fn() }));

vi.mock("../src/modes/interactive/model-catalog-refresh.ts", () => ({ refreshModelCatalogs }));
vi.mock("../src/utils/version-check.ts", () => ({ checkForNewPiVersion: vi.fn().mockResolvedValue(null) }));

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode startup", () => {
	it("does not refresh remote model catalogs during startup", async () => {
		const stop = new Error("stop after startup policy");
		const mode = {
			init: vi.fn().mockResolvedValue(undefined),
			version: "test",
			checkForPackageUpdates: vi.fn(() => {
				throw stop;
			}),
		};

		await expect(InteractiveMode.prototype.run.call(mode as never)).rejects.toBe(stop);
		expect(refreshModelCatalogs).not.toHaveBeenCalled();
	});
});
