/**
 * The confirmed rulebook in force (plan §6.4): `rulebookFromLedger` over the `rule.*` entries of every
 * expert session, in ledger order across sessions. Recomputed only when the ledger has grown (the
 * latest row id is the cache key; the ledger is append-only). Only `runtime-init.ts` imports this
 * module: it reads SQLite directly, which route bundles must never load.
 */
import "server-only";
import { RULE_EVENT_KINDS, rulebookFromLedger, type LedgerSource, type Rulebook } from "@vashistha/core";
import type { OpenedDatabase } from "@vashistha/core/server";

type Row = { id: string; source: LedgerSource; kind: string; payload: string };

const KINDS = Object.values(RULE_EVENT_KINDS);

export function createLedgerRulebook(sqlite: OpenedDatabase["sqlite"]): () => Rulebook {
  const latest = sqlite.prepare<[], { latest: number | null }>("SELECT max(rowid) AS latest FROM ledger_entries");
  const ruleEvents = sqlite.prepare<string[], Row>(
    `SELECT e.id, e.source, e.kind, e.payload FROM ledger_entries e
     WHERE e.kind IN (${KINDS.map(() => "?").join(", ")})
       AND e.session_id IN (
         SELECT s.session_id FROM ledger_entries s
         WHERE s.kind = 'session.started' AND s.source = 'engine' AND json_extract(s.payload, '$.mode') = 'expert')
     ORDER BY e.received_at, e.session_id, e.sequence`,
  );
  let cached: { key: number; book: Rulebook } | undefined;
  return () => {
    const key = latest.get()?.latest ?? 0;
    if (cached?.key !== key) {
      const entries = ruleEvents.all(...KINDS).map((r) => ({ id: r.id, source: r.source, kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
      cached = { key, book: rulebookFromLedger(entries) };
    }
    return cached.book;
  };
}
