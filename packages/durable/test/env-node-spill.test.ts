import type * as Fs from "node:fs";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

// Keep the spill pending beyond the shell's post-exit stdio grace period.
const SPILL_WRITE_DELAY_MS = 600;
const spill = vi.hoisted(() => ({ rejectedWrites: 0, writeGate: Promise.resolve() }));

// Make the spill stream deterministically slow and immediately backpressured.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		createWriteStream: (path: Fs.PathLike, options?: Parameters<typeof Fs.createWriteStream>[1]) => {
			const stream = actual.createWriteStream(
				path,
				typeof options === "object" ? { ...options, highWaterMark: 1 } : { highWaterMark: 1 },
			);
			const writeChunk = stream._write.bind(stream);
			stream._write = (chunk, encoding, callback) => {
				setTimeout(() => {
					void spill.writeGate.then(() => writeChunk(chunk, encoding, callback));
				}, SPILL_WRITE_DELAY_MS);
			};
			const writeChunks = stream._writev?.bind(stream);
			if (writeChunks !== undefined) {
				stream._writev = (chunks, callback) => {
					setTimeout(() => {
						void spill.writeGate.then(() => writeChunks(chunks, callback));
					}, SPILL_WRITE_DELAY_MS);
				};
			}
			const write = stream.write.bind(stream);
			stream.write = ((...args: Parameters<Fs.WriteStream["write"]>) => {
				const accepted = Reflect.apply(write, stream, args) as boolean;
				if (!accepted) spill.rejectedWrites++;
				return accepted;
			}) as Fs.WriteStream["write"];
			return stream;
		},
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	spill.rejectedWrites = 0;
	spill.writeGate = Promise.resolve();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("NodeExecutionEnv spill backpressure", () => {
	it.skipIf(process.platform === "win32").each([0.2, 0.8])(
		"keeps inherited stdio open while a spill is pending and descendant output waits %s seconds",
		async (delay) => {
			const root = join(tmpdir(), `pi-durable-env-spill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(root, { recursive: true });
			tempDirs.push(root);
			const env = new NodeExecutionEnv({ cwd: root });
			const spillGate = Promise.withResolvers<void>();
			spill.writeGate = spillGate.promise;
			// The shell exits after the first chunk crosses the spill threshold and backpressures the spill. A background
			// descendant retains stdout and writes after the post-exit grace period. Without the pending-spill guard,
			// settlement destroys stdout before that descendant output is read.
			const command = `printf '%020d' 0 | tr 0 a; (sleep ${delay}; printf '%01000d' 0 | tr 0 b; : > descendant-output-written) &`;

			let output = "";
			const pending = env.exec(
				command,
				{
					spill: { afterBytes: 10, afterLines: 10 },
					onOutput: (text) => {
						output += text;
					},
				},
				BACKGROUND_CONTEXT,
			);
			try {
				// Scheduling may outlast the fixed delay; keep the spill blocked until all output is written.
				await expect.poll(() => existsSync(join(root, "descendant-output-written")), { timeout: 5_000 }).toBe(true);
			} finally {
				spillGate.resolve();
				await pending;
			}
			const result = getOrThrow(await pending);

			expect(result.spillPath).toBeDefined();
			tempDirs.push(join(result.spillPath!, ".."));
			expect(spill.rejectedWrites).toBeGreaterThan(0);
			expect(output).toHaveLength(1020);
			expect(getOrThrow(await env.readTextFile(result.spillPath!, BACKGROUND_CONTEXT))).toBe(
				`${"a".repeat(20)}${"b".repeat(1000)}`,
			);
		},
		10_000,
	);
});
