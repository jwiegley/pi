import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
	closedFds: [] as number[],
	events: [] as string[],
	failAtCall: Number.POSITIVE_INFINITY,
	linkRace: undefined as "rival" | "swap-temp" | undefined,
	maxWriteBytes: Number.POSITIVE_INFINITY,
	modesDuringWrite: [] as number[],
	partialWrites: 0,
	writeCalls: 0,
	writtenFds: [] as number[],
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		closeSync(fd: number): void {
			fsState.closedFds.push(fd);
			actual.closeSync(fd);
		},
		fsyncSync(fd: number): void {
			fsState.events.push(fsState.writtenFds.includes(fd) ? "file-fsync" : "directory-fsync");
			actual.fsyncSync(fd);
		},
		linkSync(existingPath: string, newPath: string): void {
			fsState.events.push("link");
			if (fsState.linkRace === "rival") actual.writeFileSync(newPath, "rival output");
			if (fsState.linkRace === "swap-temp") {
				actual.unlinkSync(existingPath);
				actual.writeFileSync(existingPath, "substituted temp", { mode: 0o600 });
			}
			actual.linkSync(existingPath, newPath);
		},
		unlinkSync(path: string): void {
			fsState.events.push("unlink");
			actual.unlinkSync(path);
		},
		writeSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset): number {
			fsState.writeCalls++;
			fsState.writtenFds.push(fd);
			fsState.modesDuringWrite.push(actual.fstatSync(fd).mode & 0o777);
			if (fsState.writeCalls === fsState.failAtCall) throw new Error("synthetic write failure");
			const writeLength = Math.min(length, fsState.maxWriteBytes);
			if (writeLength < length) fsState.partialWrites++;
			return actual.writeSync(fd, buffer, offset, writeLength);
		},
	};
});

const { exportFromFile } = await import("../src/core/export-html/index.ts");

const roots: string[] = [];

beforeEach(() => {
	fsState.closedFds.length = 0;
	fsState.events.length = 0;
	fsState.failAtCall = Number.POSITIVE_INFINITY;
	fsState.linkRace = undefined;
	fsState.maxWriteBytes = Number.POSITIVE_INFINITY;
	fsState.modesDuringWrite.length = 0;
	fsState.partialWrites = 0;
	fsState.writeCalls = 0;
	fsState.writtenFds.length = 0;
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { inputPath: string; outputPath: string; root: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-export-write-"));
	roots.push(root);
	const inputPath = join(root, "session.jsonl");
	const outputPath = join(root, "session.html");
	writeFileSync(
		inputPath,
		`${[
			{
				type: "session",
				version: 3,
				id: "write-test",
				timestamp: "2026-08-06T12:00:00.000Z",
				cwd: "/tmp/project",
			},
			{
				type: "custom",
				id: "01",
				parentId: null,
				timestamp: "2026-08-06T12:00:01.000Z",
				customType: "write-test",
				data: "payload",
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	return { inputPath, outputPath, root };
}

describe("HTML export writes", () => {
	it("retries partial writes until the complete HTML is on disk", async () => {
		const { inputPath, outputPath } = fixture();
		fsState.maxWriteBytes = 4096;

		await exportFromFile(inputPath, { outputPath });

		expect(fsState.partialWrites).toBeGreaterThan(0);
		expect(new Set(fsState.modesDuringWrite)).toEqual(new Set([0o600]));
		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain('<script id="session-data" type="application/json">');
		expect(html).toMatch(/<\/html>\s*$/);
		const fileSync = fsState.events.lastIndexOf("file-fsync");
		const link = fsState.events.indexOf("link", fileSync + 1);
		const firstDirectorySync = fsState.events.indexOf("directory-fsync", link + 1);
		const unlink = fsState.events.indexOf("unlink", (firstDirectorySync >= 0 ? firstDirectorySync : link) + 1);
		const secondDirectorySync = fsState.events.indexOf("directory-fsync", unlink + 1);
		expect(fileSync).toBeGreaterThanOrEqual(0);
		expect(link).toBeGreaterThan(fileSync);
		if (process.platform === "win32") {
			expect(firstDirectorySync).toBe(-1);
			expect(unlink).toBeGreaterThan(link);
		} else {
			expect(firstDirectorySync).toBeGreaterThan(link);
			expect(unlink).toBeGreaterThan(firstDirectorySync);
			expect(secondDirectorySync).toBeGreaterThan(unlink);
		}
	});

	it("closes the output descriptor when a write fails", async () => {
		const { inputPath, outputPath, root } = fixture();
		fsState.maxWriteBytes = 4096;
		fsState.failAtCall = 2;

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow("synthetic write failure");

		expect(fsState.writtenFds).not.toHaveLength(0);
		for (const fd of new Set(fsState.writtenFds)) expect(fsState.closedFds).toContain(fd);
		expect(existsSync(outputPath)).toBe(false);
		expect(readdirSync(root).filter((name) => name.startsWith(".pi-export-"))).toEqual([]);
	});

	it("refuses an existing regular output without changing it", async () => {
		const { inputPath, outputPath, root } = fixture();
		const original = Buffer.from("existing export");
		writeFileSync(outputPath, original, { mode: 0o640 });
		const originalMode = statSync(outputPath).mode & 0o7777;

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(
			"HTML export output already exists; choose a different path or remove it first",
		);

		expect(readFileSync(outputPath)).toEqual(original);
		expect(statSync(outputPath).mode & 0o7777).toBe(originalMode);
		expect(readdirSync(root).filter((name) => name.startsWith(".pi-export-"))).toEqual([]);
	});

	it("publishes a complete new output with the caller's normal file mode", async () => {
		const { inputPath, outputPath } = fixture();

		await exportFromFile(inputPath, { outputPath });

		expect(statSync(outputPath).mode & 0o777).toBe(0o666 & ~process.umask() & 0o777);
	});

	it("does not clobber a rival output created at the publication point", async () => {
		const { inputPath, outputPath, root } = fixture();
		const source = readFileSync(inputPath);
		fsState.linkRace = "rival";

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow(/EEXIST/);

		expect(readFileSync(inputPath)).toEqual(source);
		expect(readFileSync(outputPath, "utf8")).toBe("rival output");
		expect(readdirSync(root).filter((name) => name.startsWith(".pi-export-"))).toEqual([]);
	});

	it("does not report success when the private temp identity is substituted", async () => {
		const { inputPath, outputPath } = fixture();
		fsState.linkRace = "swap-temp";

		await expect(exportFromFile(inputPath, { outputPath })).rejects.toThrow("HTML export publication may exist");

		expect(readFileSync(outputPath, "utf8")).toBe("substituted temp");
	});
});
