import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewLedgerEntry } from "../src";
import { DATABASE_FILENAME, createLedger, openDatabase, type OpenedDatabase } from "../src/server";

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
    expect(migrations).toEqual({ n: 2 });
    second.close();

    const third = openDatabase({ dataDir });
    expect(third.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 2 });
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
