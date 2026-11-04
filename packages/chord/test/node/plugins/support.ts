// Test support for the plugins component (slice 7c, slice 12): fixture plugins copied into temporary roots, plugins, npm
// packages and local bare git repositories written there (no network), the host packages the fixtures import, and
// waiting for file system events.

import { execFileSync } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach } from "vitest";
import * as chord from "../../../src/index.ts";
import type { HostPackages, KindDefinition } from "../../../src/node/plugins/index.ts";

/** The fixture plugins' directory. */
export const FIXTURES = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));

/** The host packages the fixtures import: this process's Chord. */
export const HOST_PACKAGES: HostPackages = { "@earendil-works/chord": chord };

/** The facet kinds of the fixtures' app. */
export const KINDS = ["server", "worker", "web"] as const;

/** The fixtures' app's kinds as the component takes them: Node servers and workers, a browser web, `modules`' names. */
export function kindsOf(modules: HostPackages): Readonly<Record<string, KindDefinition>> {
	const hostPackages = Object.keys(modules);
	return {
		server: { platform: "node", hostPackages },
		worker: { platform: "node", hostPackages },
		web: { platform: "browser", hostPackages },
	};
}

const made: string[] = [];

afterEach(async () => {
	for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the test; `fixtures` (names of fixture plugins) copied into it. */
export async function tempRoot(fixtures: readonly string[] = []): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "chord-plugins-"));
	made.push(root);
	for (const name of fixtures) await cp(join(FIXTURES, name), join(root, name), { recursive: true });
	return root;
}

/** How long a test waits for a file system event: FSEvents (macOS) delivers late, by seconds on a busy machine. */
export const EVENT_WAIT = 20_000;

/** The timeout of a test that waits for file system events. */
export const EVENT_TEST = 60_000;

/** The directory `settleFileEvents` writes into and its watch, made at its first call. */
let sentinels: { readonly dir: string; readonly watcher: FSWatcher; readonly seen: Set<string> } | undefined;
let sentinel = 0;

afterAll(async () => {
	if (sentinels === undefined) return;
	sentinels.watcher.close();
	await rm(sentinels.dir, { recursive: true, force: true });
	sentinels = undefined;
});

/**
 * Resolves once every file change made so far has reached this process's watches, and every watch made so far is live:
 * a watched directory of its own gets a new file every 250 ms until one's event arrives (events arrive in order). On
 * macOS a watch goes live only after `fs.watch` returned, FSEvents reports changes made shortly before that (a
 * fixture's writes), and its events arrive late; with inotify (Linux) the first file's event arrives at once.
 */
export async function settleFileEvents(): Promise<void> {
	if (sentinels === undefined) {
		const dir = await mkdtemp(join(tmpdir(), "chord-events-"));
		const seen = new Set<string>();
		const watcher = watch(dir, { persistent: false }, (_event, file) => {
			if (file !== null) seen.add(file);
		});
		sentinels = { dir, watcher, seen };
	}
	const { dir, seen } = sentinels;
	const written: string[] = [];
	const arrived = () => written.some((name) => seen.has(name));
	const deadline = Date.now() + EVENT_WAIT;
	while (!arrived()) {
		if (Date.now() > deadline) throw new Error(`settleFileEvents: no event from ${dir} in ${EVENT_WAIT} ms`);
		const name = `${sentinel++}`;
		written.push(name);
		await writeFile(join(dir, name), "");
		for (const until = Date.now() + 250; Date.now() < until && !arrived(); ) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

/** Writes `files` (relative path to text) into `dir`, creating directories. */
export async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), text);
	}
}

/** Writes a plugin named `name` into `root/dir`: its `package.json` (with `manifest`'s fields) and `files`. */
export async function writePlugin(
	root: string,
	dir: string,
	name: string,
	files: Readonly<Record<string, string>>,
	manifest: Readonly<Record<string, unknown>> = {},
): Promise<string> {
	const path = join(root, dir);
	await writeFiles(path, { "package.json": JSON.stringify({ name, type: "module", ...manifest }), ...files });
	return path;
}

/** Writes an npm package `name` into `dir`'s `node_modules`: its `package.json` (CommonJS unless `type`) and files. */
export async function writePackage(
	dir: string,
	name: string,
	files: Readonly<Record<string, string>>,
	manifest: Readonly<Record<string, unknown>> = {},
): Promise<void> {
	const main = Object.keys(files)[0]!;
	const json = JSON.stringify({ name, version: "1.0.0", main, ...manifest });
	await writeFiles(join(dir, "node_modules", name), { "package.json": json, ...files });
}

/**
 * A local bare git repository `<name>.git` in a temporary directory with `files` committed (one commit), tagged `tag`:
 * its `file://` URL and the commit. A call with `previous` adds another commit on top of that repository.
 */
export async function gitRepository(
	name: string,
	files: Readonly<Record<string, string>>,
	tag: string,
	previous?: { readonly work: string; readonly bare: string },
): Promise<{ readonly url: string; readonly commit: string; readonly work: string; readonly bare: string }> {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
			cwd,
			encoding: "utf8",
		}).trim();
	const work = previous?.work ?? (await tempRoot());
	if (previous === undefined) git(work, "init", "--quiet");
	await writeFiles(work, files);
	git(work, "add", "--all");
	git(work, "commit", "--quiet", "--message", tag);
	git(work, "tag", tag);
	const bare = previous?.bare ?? join(await tempRoot(), `${name}.git`);
	if (previous === undefined) git(work, "clone", "--quiet", "--bare", work, bare);
	else git(work, "push", "--quiet", "--tags", bare, "HEAD:refs/heads/master");
	return { url: `file://${bare}`, commit: git(work, "rev-parse", "HEAD"), work, bare };
}
