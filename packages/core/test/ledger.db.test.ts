import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewLedgerEntry } from "../src";
import { DATABASE_FILENAME, createLedger, openDatabase, type OpenedDatabase } from "../src/server";
import * as schema from "../src/server/db/schema";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
const MIGRATIONS = JOURNAL.entries.length;

function entry(sessionId: string, over: Partial<NewLedgerEntry> = {}): NewLedgerEntry {
  return {
    sessionId,
    source: "client",
    kind: "frame.received",
    occurredAt: 1,
    traceId: "trace",
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch: 0,
    payload: { ok: true },
    ...over,
  };
}

describe("append-only triggers", () => {
  let opened: OpenedDatabase;
  let childId: string;

  beforeEach(() => {
    opened = openDatabase({ memory: true });
    const ledger = createLedger(opened.db);
    ledger.createSession({ id: "s" });
    const parent = ledger.append(entry("s"));
    childId = ledger.append(entry("s", { source: "vision", parentIds: [parent.id] })).id;
  });

  afterEach(() => opened.close());

  it.each([
    ["UPDATE ledger_entries", "UPDATE ledger_entries SET kind = 'tampered'"],
    ["DELETE ledger_entries", "DELETE FROM ledger_entries"],
    ["UPDATE ledger_edges", "UPDATE ledger_edges SET parent_id = child_id"],
    ["DELETE ledger_edges", "DELETE FROM ledger_edges"],
  ])("%s is refused", (_name, statement) => {
    expect(() => opened.sqlite.prepare(statement).run()).toThrow(/append-only/);
    expect(opened.sqlite.prepare("SELECT count(*) AS n FROM ledger_entries").get()).toEqual({ n: 2 });
    expect(opened.sqlite.prepare("SELECT count(*) AS n FROM ledger_edges").get()).toEqual({ n: 1 });
    expect(opened.sqlite.prepare("SELECT kind FROM ledger_entries WHERE id = ?").get(childId)).toEqual({ kind: "frame.received" });
  });

  it.each([
    ["rewind the privacy epoch", "UPDATE sessions SET privacy_epoch = privacy_epoch - 1"],
    ["rewind the sequence", "UPDATE sessions SET next_sequence = 0"],
    ["rename the session", "UPDATE sessions SET id = 'other'"],
  ])("sessions cannot %s", (_name, statement) => {
    expect(() => opened.sqlite.prepare(statement).run()).toThrow(/never decrease|immutable/);
  });

  it("refuses to delete a session that has entries", () => {
    expect(() => opened.sqlite.prepare("DELETE FROM sessions").run()).toThrow(/FOREIGN KEY/);
  });
});

describe("file-backed database", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), "vashistha-ledger-")), "nested", "data");
  });

  afterEach(() => rmSync(join(dataDir, "..", ".."), { recursive: true, force: true }));

  it("creates the data dir, uses WAL and persists across reopen", () => {
    const first = openDatabase({ dataDir });
    expect(existsSync(join(dataDir, DATABASE_FILENAME))).toBe(true);
    expect(first.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    const ledger = createLedger(first.db);
    ledger.createSession({ id: "s" });
    ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" });
    const written = ledger.append(entry("s", { source: "engine", privacyEpoch: 0 }));
    first.close();

    const second = openDatabase({ dataDir });
    const reopened = createLedger(second.db);
    expect(reopened.get(written.id)).toEqual(written);
    expect(reopened.getSession("s")).toMatchObject({ privacyEpoch: 1, offRecord: true });
    expect(reopened.append(entry("s", { source: "engine" })).sequence).toBe(2);
    const migrations = second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get();
    expect(migrations).toEqual({ n: MIGRATIONS });
    second.close();

    const third = openDatabase({ dataDir });
    expect(third.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATIONS });
    expect(createLedger(third.db).list("s")).toHaveLength(3);
    third.close();
  });

  it("keeps sequences gap-free across two connections to the same file", () => {
    const a = openDatabase({ dataDir });
    const b = openDatabase({ dataDir });
    const ledgerA = createLedger(a.db);
    const ledgerB = createLedger(b.db);
    ledgerA.createSession({ id: "s" });
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) seqs.push((i % 2 === 0 ? ledgerA : ledgerB).append(entry("s")).sequence);
    expect(seqs).toEqual([...Array(20).keys()]);
    a.close();
    b.close();
  });
});

describe("migrating a production database (ledger kind indexes, 0002)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vashistha-migrate-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A database file migrated only up to `0001_append_only` (production before this release), holding a session and two entries. */
  function productionDatabase(dataDir: string): void {
    const folder = join(root, "migrations-0001");
    mkdirSync(join(folder, "meta"), { recursive: true });
    const entries = JOURNAL.entries.filter((e) => e.tag === "0000_init" || e.tag === "0001_append_only");
    expect(entries).toHaveLength(2);
    for (const e of entries) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...JOURNAL, entries }));
    mkdirSync(dataDir, { recursive: true });
    const sqlite = new BetterSqlite3(join(dataDir, DATABASE_FILENAME));
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: folder });
    const ledger = createLedger(db);
    ledger.createSession({ id: "s" });
    ledger.append(entry("s"));
    ledger.append(entry("s", { source: "engine", kind: "rule.confirmed" }));
    sqlite.close();
  }

  const indexes = (o: OpenedDatabase): string[] =>
    o.sqlite
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_entries' AND name LIKE 'ledger_entries_%' ORDER BY name")
      .all()
      .map((r) => r.name);

  it("adds the indexes once, keeps every row and the append-only triggers, and is a no-op on reopen", () => {
    const dataDir = join(root, "data");
    productionDatabase(dataDir);

    const first = openDatabase({ dataDir });
    expect(first.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATIONS });
    expect(indexes(first)).toEqual(expect.arrayContaining(["ledger_entries_kind_idx", "ledger_entries_session_kind_idx"]));
    expect(createLedger(first.db).list("s").map((e) => e.kind)).toEqual(["frame.received", "rule.confirmed"]);
    expect(() => first.sqlite.prepare("UPDATE ledger_entries SET kind = 'tampered'").run()).toThrow(/append-only/);
    expect(() => first.sqlite.prepare("DELETE FROM ledger_entries").run()).toThrow(/append-only/);
    const plan = first.sqlite
      .prepare<[], { detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM ledger_entries WHERE kind = 'rule.confirmed' AND rowid > 1")
      .all()
      .map((r) => r.detail);
    expect(plan.join("\n")).toContain("USING INDEX ledger_entries_kind_idx");
    first.close();

    const second = openDatabase({ dataDir });
    expect(second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATIONS });
    expect(createLedger(second.db).append(entry("s")).sequence).toBe(2);
    second.close();
  });

  it("succeeds when an index was already created by hand", () => {
    const dataDir = join(root, "data");
    productionDatabase(dataDir);
    const sqlite = new BetterSqlite3(join(dataDir, DATABASE_FILENAME));
    sqlite.exec("CREATE INDEX `ledger_entries_kind_idx` ON `ledger_entries` (`kind`)");
    sqlite.close();

    const opened = openDatabase({ dataDir });
    expect(indexes(opened)).toEqual(expect.arrayContaining(["ledger_entries_kind_idx", "ledger_entries_session_kind_idx"]));
    expect(opened.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATIONS });
    opened.close();
  });
});
