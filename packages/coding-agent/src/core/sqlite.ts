import { createRequire } from "node:module";
import type { SQLInputValue, SQLOutputValue, StatementResultingChanges } from "node:sqlite";

type Row = Record<string, SQLOutputValue>;

export interface StatementSync {
	get(...values: SQLInputValue[]): Row | undefined;
	all(...values: SQLInputValue[]): Row[];
	iterate(...values: SQLInputValue[]): IterableIterator<Row>;
	run(...values: SQLInputValue[]): StatementResultingChanges;
}

export interface DatabaseSync {
	exec(sql: string): void;
	prepare(sql: string): StatementSync;
	close(): void;
}

interface RuntimeStatement {
	get(...values: SQLInputValue[]): Row | null | undefined;
	all(...values: SQLInputValue[]): Row[];
	iterate(...values: SQLInputValue[]): IterableIterator<Row>;
	run(...values: SQLInputValue[]): StatementResultingChanges;
	finalize?: () => void;
}

interface RuntimeDatabase {
	exec(sql: string): unknown;
	prepare(sql: string): RuntimeStatement;
	close(): unknown;
}

const require = createRequire(import.meta.url);
const isBun = "bun" in process.versions;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function hasMethod(value: Record<PropertyKey, unknown>, name: string): boolean {
	return typeof value[name] === "function";
}

function isRuntimeDatabase(value: unknown): value is RuntimeDatabase {
	return isRecord(value) && hasMethod(value, "exec") && hasMethod(value, "prepare") && hasMethod(value, "close");
}

function isRuntimeStatement(value: unknown): value is RuntimeStatement {
	return (
		isRecord(value) &&
		hasMethod(value, "get") &&
		hasMethod(value, "all") &&
		hasMethod(value, "iterate") &&
		hasMethod(value, "run") &&
		(value.finalize === undefined || typeof value.finalize === "function")
	);
}

function runtimeDatabaseClass() {
	const loaded: unknown = require(isBun ? "bun:sqlite" : "node:sqlite");
	if (!isRecord(loaded)) throw new Error("The synchronous SQLite module has an invalid shape");
	const databaseClass = loaded.DatabaseSync ?? loaded.Database;
	if (typeof databaseClass !== "function") {
		throw new Error("This runtime does not provide a synchronous SQLite database");
	}
	return databaseClass;
}

const RuntimeDatabase = runtimeDatabaseClass();

class CompatibleStatement implements StatementSync {
	private readonly statement: RuntimeStatement;

	constructor(statement: RuntimeStatement) {
		this.statement = statement;
	}

	get(...values: SQLInputValue[]): Row | undefined {
		return this.statement.get(...values) ?? undefined;
	}

	all(...values: SQLInputValue[]): Row[] {
		return this.statement.all(...values);
	}

	iterate(...values: SQLInputValue[]): IterableIterator<Row> {
		return this.statement.iterate(...values);
	}

	run(...values: SQLInputValue[]): StatementResultingChanges {
		return this.statement.run(...values);
	}
}

class CompatibleDatabase implements DatabaseSync {
	private readonly database: RuntimeDatabase;
	private readonly statementRefs = new Set<WeakRef<RuntimeStatement>>();
	private readonly statementFinalizer = new FinalizationRegistry<WeakRef<RuntimeStatement>>((reference) => {
		this.statementRefs.delete(reference);
	});
	private databaseClosed = false;

	constructor(location: string) {
		const database: unknown = Reflect.construct(RuntimeDatabase, [location]);
		if (!isRuntimeDatabase(database)) throw new Error("The synchronous SQLite database has an invalid shape");
		this.database = database;
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	prepare(sql: string): StatementSync {
		const statement: unknown = this.database.prepare(sql);
		if (!isRuntimeStatement(statement)) throw new Error("The synchronous SQLite statement has an invalid shape");
		if (isBun) {
			const reference = new WeakRef(statement);
			this.statementRefs.add(reference);
			this.statementFinalizer.register(statement, reference, reference);
		}
		return new CompatibleStatement(statement);
	}

	close(): void {
		let firstError: unknown;
		for (const reference of this.statementRefs) {
			const statement = reference.deref();
			if (!statement) {
				this.statementRefs.delete(reference);
				continue;
			}
			try {
				statement.finalize?.();
				this.statementFinalizer.unregister(reference);
				this.statementRefs.delete(reference);
			} catch (error) {
				firstError ??= error;
			}
		}
		if (!this.databaseClosed) {
			try {
				this.database.close();
				this.databaseClosed = true;
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) throw firstError;
	}
}

export const DatabaseSync: new (location: string) => DatabaseSync = CompatibleDatabase;
