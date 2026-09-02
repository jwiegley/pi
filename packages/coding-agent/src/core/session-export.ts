import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

/** Write the current session branch and optional trailing export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: (parentId: string | null, timestamp: string) => readonly object[],
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile) {
		const sourcePath = resolvePath(sessionFile, process.cwd());
		const sourceIdentity = statSync(sourcePath, { bigint: true, throwIfNoEntry: false });
		const destinationIdentity = statSync(filePath, { bigint: true, throwIfNoEntry: false });
		const aliasesSource =
			filePath === sourcePath ||
			(sourceIdentity !== undefined &&
				destinationIdentity !== undefined &&
				sourceIdentity.dev === destinationIdentity.dev &&
				sourceIdentity.ino === destinationIdentity.ino);
		if (aliasesSource) throw new Error(`Cannot export JSONL over the active session file: ${filePath}`);
	}
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const temporaryPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	const destination = openSync(temporaryPath, "wx");
	try {
		try {
			writeFileSync(destination, `${JSON.stringify(header)}\n`);
			let parentId: string | null = null;
			sessionManager.iterateBranchEntries((entry) => {
				writeFileSync(destination, `${JSON.stringify({ ...entry, parentId })}\n`);
				parentId = entry.id;
			});
			for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
				writeFileSync(destination, `${JSON.stringify(entry)}\n`);
			}
			fsyncSync(destination);
		} finally {
			closeSync(destination);
		}
		renameSync(temporaryPath, filePath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {}
		throw error;
	}
	return filePath;
}
