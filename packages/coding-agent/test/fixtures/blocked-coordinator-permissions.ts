import { existsSync, promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout } from "node:timers/promises";
import { runCoordinatorProcess } from "../../src/experimental/coordinator.ts";

const [publicPath, controlPath] = process.argv.slice(2);
if (!publicPath || !controlPath) throw new Error("Expected public and control socket paths");

const chmod = fs.chmod;
fs.chmod = async (path, mode) => {
	if (path === publicPath) {
		await fs.writeFile(`${publicPath}.blocked`, "");
		while (!existsSync(`${publicPath}.release`)) await setTimeout(10);
	}
	await chmod(path, mode);
};
syncBuiltinESMExports();

await runCoordinatorProcess([publicPath, controlPath]);
