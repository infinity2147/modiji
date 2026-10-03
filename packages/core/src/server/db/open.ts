import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export type OpenDatabaseOptions = { dataDir: string } | { memory: true };

export type OpenedDatabase = {
  db: Db;
  sqlite: BetterSqlite3.Database;
  close: () => void;
};

export const DATABASE_FILENAME = "vashistha.db";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(opts: OpenDatabaseOptions): OpenedDatabase {
  const memory = "memory" in opts;
  if (!memory) mkdirSync(opts.dataDir, { recursive: true });
  const sqlite = new BetterSqlite3(memory ? ":memory:" : join(opts.dataDir, DATABASE_FILENAME));
  try {
    if (!memory) sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("synchronous = NORMAL");
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return { db, sqlite, close: () => sqlite.close() };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
