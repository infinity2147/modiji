import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerSource, NewLedgerEntry } from "../src";
import {
  LedgerError,
  OffRecordError,
  StaleEpochError,
  createLedger,
  openDatabase,
  type Ledger,
  type OpenedDatabase,
} from "../src/server";

function entry(sessionId: string, over: Partial<NewLedgerEntry> = {}): NewLedgerEntry {
  return {
    sessionId,
    source: "engine",
    kind: "test.entry",
    occurredAt: 1_000,
    traceId: "trace-1",
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch: 0,
    payload: { n: 1 },
    ...over,
  };
}

function expectLedgerError(fn: () => unknown, code: LedgerError["code"]): LedgerError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe(code);
    return err as LedgerError;
  }
  throw new Error(`expected LedgerError ${code}`);
}

const CAPTURE: LedgerSource[] = ["client", "vision", "dom", "voice"];
const NON_CAPTURE: LedgerSource[] = ["engine", "solver", "expert", "system_control"];

let opened: OpenedDatabase;
let ledger: Ledger;
let clock: number;
let ids: number;
/** When set, the next generated id; lets tests force a primary-key collision. */
let forcedId: string | undefined;

beforeEach(() => {
  opened = openDatabase({ memory: true });
  clock = 10_000;
  ids = 0;
  forcedId = undefined;
  ledger = createLedger(opened.db, {
    now: () => clock++,
    newId: () => {
      const id = forcedId ?? `id-${++ids}`;
      forcedId = undefined;
      return id;
    },
  });
});

afterEach(() => opened.close());

describe("sessions", () => {
  it("creates and reads sessions", () => {
    const s = ledger.createSession({ id: "s1" });
    expect(s).toEqual({ id: "s1", createdAt: 10_000, privacyEpoch: 0, offRecord: false });
    expect(ledger.getSession("s1")).toEqual(s);
    expect(ledger.getSession("nope")).toBeUndefined();
    expect(ledger.createSession().id).toBe("id-1");
  });

  it("rejects a duplicate session id", () => {
    ledger.createSession({ id: "s1" });
    expectLedgerError(() => ledger.createSession({ id: "s1" }), "session_exists");
  });

  it("rejects appends to an unknown session", () => {
    expectLedgerError(() => ledger.append(entry("ghost")), "session_not_found");
  });
});

describe("append", () => {
  it("assigns id, receivedAt and a gap-free sequence per session", () => {
    ledger.createSession({ id: "a" });
    ledger.createSession({ id: "b" });
    const a = [0, 1, 2, 3].map(() => ledger.append(entry("a")));
    const b = [0, 1].map(() => ledger.append(entry("b")));
    expect(a.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(b.map((e) => e.sequence)).toEqual([0, 1]);
    expect(a[0]).toMatchObject({ id: "id-1", receivedAt: 10_002, payload: { n: 1 } });
    expect(ledger.get(a[0]!.id)).toEqual(a[0]);
    expect(ledger.get("missing")).toBeUndefined();
  });

  it("keeps both sessions monotonic under interleaved async appends", async () => {
    ledger.createSession({ id: "a" });
    ledger.createSession({ id: "b" });
    const writer = async (sessionId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        ledger.append(entry(sessionId, { payload: { i } }));
      }
    };
    await Promise.all([writer("a", 25), writer("b", 25), writer("a", 25)]);
    expect(ledger.list("a").map((e) => e.sequence)).toEqual([...Array(50).keys()]);
    expect(ledger.list("b").map((e) => e.sequence)).toEqual([...Array(25).keys()]);
    expect(ledger.getSession("a")).toMatchObject({ id: "a" });
  });

  it("returns the JSON round-tripped payload and rejects non-serialisable ones", () => {
    ledger.createSession({ id: "s" });
    const e = ledger.append(entry("s", { payload: { at: new Date(0), skip: undefined } }));
    expect(e.payload).toEqual({ at: "1970-01-01T00:00:00.000Z" });
    expect(ledger.get(e.id)).toEqual(e);
    expectLedgerError(() => ledger.append(entry("s", { payload: undefined })), "invalid_entry");
    expectLedgerError(() => ledger.append(entry("s", { payload: { n: 1n } })), "invalid_entry");
    expect(ledger.list("s")).toHaveLength(1);
  });

  it.each([
    ["bad kind", { kind: "Not A Kind" }],
    ["unknown source", { source: "screen" }],
    ["negative epoch", { privacyEpoch: -1 }],
    ["empty trace id", { traceId: "" }],
    ["schemaVersion 0", { schemaVersion: 0 }],
    ["extra key", { extra: true }],
  ])("rejects an invalid entry shape: %s", (_name, over) => {
    ledger.createSession({ id: "s" });
    const err = expectLedgerError(() => ledger.append({ ...entry("s"), ...over } as NewLedgerEntry), "invalid_entry");
    expect(err.message).toMatch(/invalid ledger entry/);
    expect(ledger.getSession("s")).toBeDefined();
    expect(ledger.list("s")).toEqual([]);
  });
});

describe("provenance", () => {
  it("rejects a missing parent and writes nothing", () => {
    ledger.createSession({ id: "s" });
    const root = ledger.append(entry("s"));
    const err = expectLedgerError(() => ledger.append(entry("s", { parentIds: [root.id, "nope"] })), "parent_not_found");
    expect(err.message).toContain("nope");
    expect(ledger.list("s")).toHaveLength(1);
    expect(ledger.children(root.id)).toEqual([]);
    expect(ledger.append(entry("s")).sequence).toBe(1);
  });

  it("accepts a parent from another session and records edges", () => {
    ledger.createSession({ id: "expert" });
    ledger.createSession({ id: "novice" });
    const quote = ledger.append(entry("expert", { source: "voice", kind: "utterance.final" }));
    const tutor = ledger.append(entry("novice", { kind: "tutor.intervention", parentIds: [quote.id, quote.id] }));
    expect(tutor.parentIds).toEqual([quote.id, quote.id]);
    expect(ledger.parents(tutor.id)).toEqual([quote]);
    expect(ledger.children(quote.id)).toEqual([tutor]);
    const edges = opened.sqlite.prepare("SELECT child_id, parent_id FROM ledger_edges").all();
    expect(edges).toEqual([{ child_id: tutor.id, parent_id: quote.id }]);
  });

  it("walks a diamond DAG returning each node once", () => {
    ledger.createSession({ id: "s" });
    //   frame → (eventA, eventB) → decision → rule
    const frame = ledger.append(entry("s", { source: "client", kind: "frame.received" }));
    const eventA = ledger.append(entry("s", { source: "vision", kind: "screen_event", parentIds: [frame.id] }));
    const eventB = ledger.append(entry("s", { source: "vision", kind: "screen_event", parentIds: [frame.id] }));
    const decision = ledger.append(entry("s", { kind: "decision.observed", parentIds: [eventA.id, eventB.id] }));
    const rule = ledger.append(entry("s", { source: "expert", kind: "rule.confirmed", parentIds: [decision.id, frame.id] }));
    const unrelated = ledger.append(entry("s"));

    const ids = (es: { id: string }[]) => es.map((e) => e.id);
    expect(ids(ledger.ancestors(rule.id))).toEqual([frame.id, eventA.id, eventB.id, decision.id]);
    expect(ids(ledger.descendants(frame.id))).toEqual([eventA.id, eventB.id, decision.id, rule.id]);
    expect(ids(ledger.ancestors(frame.id))).toEqual([]);
    expect(ids(ledger.descendants(rule.id))).toEqual([]);
    expect(ids(ledger.parents(decision.id))).toEqual([eventA.id, eventB.id]);
    expect(ids(ledger.children(frame.id))).toEqual([eventA.id, eventB.id, rule.id]);
    expect(ids(ledger.descendants(unrelated.id))).toEqual([]);
  });
});

describe("privacy", () => {
  it.each(CAPTURE)("rejects a stale epoch from capture source %s", (source) => {
    ledger.createSession({ id: "s" });
    ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" });
    ledger.setOffRecord("s", false, { occurredAt: 2, traceId: "t" });
    const err = expectLedgerError(() => ledger.append(entry("s", { source, privacyEpoch: 0 })), "stale_epoch");
    expect(err).toBeInstanceOf(StaleEpochError);
    expect(err).toMatchObject({ entryEpoch: 0, sessionEpoch: 2 });
    expectLedgerError(() => ledger.append(entry("s", { source, privacyEpoch: 3 })), "stale_epoch");
    expect(ledger.append(entry("s", { source, privacyEpoch: 2 })).privacyEpoch).toBe(2);
  });

  it.each(NON_CAPTURE)("accepts any epoch from non-capture source %s", (source) => {
    ledger.createSession({ id: "s" });
    ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" });
    expect(ledger.append(entry("s", { source, privacyEpoch: 0 })).sequence).toBe(1);
  });

  it.each(CAPTURE)("rejects capture source %s while off the record, even at the current epoch", (source) => {
    ledger.createSession({ id: "s" });
    ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" });
    const err = expectLedgerError(() => ledger.append(entry("s", { source, privacyEpoch: 1 })), "off_record");
    expect(err).toBeInstanceOf(OffRecordError);
    expect(ledger.list("s").map((e) => e.source)).toEqual(["system_control"]);
  });

  it("advances the epoch on both transitions and records system_control entries", () => {
    ledger.createSession({ id: "s" });
    const off = ledger.setOffRecord("s", true, { occurredAt: 5, traceId: "t-off" });
    expect(off).toMatchObject({
      source: "system_control",
      kind: "privacy.off_record",
      privacyEpoch: 1,
      sequence: 0,
      occurredAt: 5,
      traceId: "t-off",
      payload: { offRecord: true, privacyEpoch: 1 },
    });
    expect(ledger.getSession("s")).toMatchObject({ privacyEpoch: 1, offRecord: true });

    const on = ledger.setOffRecord("s", false, { occurredAt: 6, traceId: "t-on" });
    expect(on).toMatchObject({ kind: "privacy.on_record", privacyEpoch: 2, payload: { offRecord: false, privacyEpoch: 2 } });
    expect(ledger.getSession("s")).toMatchObject({ privacyEpoch: 2, offRecord: false });
  });

  it("refuses a transition to the current state", () => {
    ledger.createSession({ id: "s" });
    expectLedgerError(() => ledger.setOffRecord("s", false, { occurredAt: 1, traceId: "t" }), "state_unchanged");
    ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" });
    expectLedgerError(() => ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" }), "state_unchanged");
    expect(ledger.getSession("s")).toMatchObject({ privacyEpoch: 1, offRecord: true });
    expectLedgerError(() => ledger.setOffRecord("ghost", true, { occurredAt: 1, traceId: "t" }), "session_not_found");
    expectLedgerError(() => ledger.setOffRecord("s", false, { occurredAt: -1, traceId: "t" }), "invalid_entry");
  });

  it("rolls the session back when the control entry cannot be written", () => {
    ledger.createSession({ id: "s" });
    const first = ledger.append(entry("s"));
    forcedId = first.id; // primary-key collision on the control entry insert
    expect(() => ledger.setOffRecord("s", true, { occurredAt: 1, traceId: "t" })).toThrow();
    expect(ledger.getSession("s")).toMatchObject({ privacyEpoch: 0, offRecord: false });
    expect(ledger.list("s")).toEqual([first]);
    expect(ledger.append(entry("s", { source: "client" })).sequence).toBe(1);
  });
});

describe("reads", () => {
  beforeEach(() => {
    ledger.createSession({ id: "s" });
    ledger.append(entry("s", { source: "client", kind: "frame.received" }));
    ledger.append(entry("s", { source: "vision", kind: "screen_event" }));
    ledger.setOffRecord("s", true, { occurredAt: 2, traceId: "t" });
    ledger.setOffRecord("s", false, { occurredAt: 3, traceId: "t" });
    ledger.append(entry("s", { source: "system_control", kind: "gate.control", privacyEpoch: 2 }));
    ledger.append(entry("s", { source: "engine", kind: "question.asked", privacyEpoch: 2 }));
  });

  it("lists in sequence order with filters", () => {
    expect(ledger.list("s").map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ledger.list("s", { sources: ["vision", "engine"] }).map((e) => e.kind)).toEqual(["screen_event", "question.asked"]);
    expect(ledger.list("s", { kinds: ["privacy.on_record"] }).map((e) => e.sequence)).toEqual([3]);
    expect(ledger.list("s", { afterSequence: 3 }).map((e) => e.sequence)).toEqual([4, 5]);
    expect(ledger.list("s", { afterSequence: 0, limit: 2 }).map((e) => e.sequence)).toEqual([1, 2]);
    expect(ledger.list("s", { sources: [] })).toEqual([]);
    expect(ledger.list("other")).toEqual([]);
  });

  it("never returns system_control entries as evidence", () => {
    expect(ledger.evidence("s").map((e) => e.source)).toEqual(["client", "vision", "engine"]);
    expect(ledger.evidence("s", { sources: ["system_control"] })).toEqual([]);
    expect(ledger.evidence("s", { kinds: ["privacy.off_record", "privacy.on_record", "gate.control"] })).toEqual([]);
    expect(ledger.evidence("s", { sources: ["system_control", "engine"], kinds: ["gate.control", "question.asked"] })).toEqual([
      expect.objectContaining({ kind: "question.asked" }),
    ]);
    expect(ledger.evidence("s", { limit: 2 }).map((e) => e.sequence)).toEqual([0, 1]);
  });
});

describe("appendMany", () => {
  it("appends all entries in order", () => {
    ledger.createSession({ id: "s" });
    const out = ledger.appendMany([entry("s", { kind: "a" }), entry("s", { kind: "b" })]);
    expect(out.map((e) => [e.kind, e.sequence])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it.each<[string, Partial<NewLedgerEntry>, LedgerError["code"]]>([
    ["an invalid shape", { kind: "BAD" }, "invalid_entry"],
    ["a missing parent", { parentIds: ["nope"] }, "parent_not_found"],
    ["a stale capture epoch", { source: "dom", privacyEpoch: 7 }, "stale_epoch"],
    ["an unknown session", { sessionId: "ghost" }, "session_not_found"],
  ])("writes nothing when one entry has %s", (_name, over, code) => {
    ledger.createSession({ id: "s" });
    ledger.append(entry("s"));
    expectLedgerError(() => ledger.appendMany([entry("s"), entry("s", over), entry("s")]), code);
    expect(ledger.list("s").map((e) => e.sequence)).toEqual([0]);
    expect(ledger.append(entry("s")).sequence).toBe(1);
  });
});
