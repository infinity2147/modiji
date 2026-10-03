/**
 * The wrapper invariant as a property (plan §7.2): over arbitrary interleavings of issuing, context
 * changes, clock movement and requests with random histories, the handler emits content only when
 * the last message is a user turn carrying a currently valid nonce for that agent, session and
 * context version that has not spoken before — and then exactly the authorised text. A valid nonce
 * seen for the first time always speaks, and an identical replay of a spoken turn always skips.
 * Some requests drop their stream mid-speech, as a lost connection would: the nonce must then be
 * free for ElevenLabs' retry, and still speak at most once in total.
 *
 * The one unauthorised non-skip reply is the off-record tool call: it carries no content (readTurn
 * rejects any), and it is emitted exactly for a known agent's last user turn that is an off-record
 * phrase and not a control message.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatControlMessage, isOffRecordPhrase, parseControlMessage } from "@vashistha/core";
import type { AgentRole } from "@vashistha/core/server";
import { chatBody, createHarness, readTurn } from "../support/llm-harness";

const RUNS = { seed: 20261004, numRuns: 400 };
const SESSIONS = ["s1", "s2"] as const;
const MODELS: Record<string, AgentRole | null> = {
  "vashistha-interviewer-v1": "interviewer",
  "vashistha-interviewer-v2": "interviewer",
  "vashistha-tutor-v1": "tutor",
  "vashistha-interviewer": null,
  "gpt-4o": null,
  "": null,
};
const ROLES = ["system", "user", "assistant", "tool"] as const;

/** Reference copy of the issued authorizations. */
type RefAuth = { nonce: string; sessionId: string; agent: AgentRole; contextVersion: number; expiresAt: number; text: string };

/** How a message's text is chosen; nonce references are resolved against what has been issued so far. */
const textArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ type: fc.constant("issued" as const), index: fc.nat(), pad: fc.constantFrom("", " ", "\n") }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("forged" as const), bytes: fc.uint8Array({ minLength: 16, maxLength: 48 }) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("near_miss" as const),
      index: fc.nat(),
      form: fc.constantFrom("prefix", "suffix", "brackets", "truncated", "doubled"),
    }),
  },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("free" as const), text: fc.string({ maxLength: 40 }) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("phrase" as const),
      text: fc.constantFrom(
        "Off the record.",
        "Let's go off the record for a moment.",
        "pause recording",
        "रिकॉर्डिंग बंद करो",
        "the record shows the owner is verified",
        "I would never say anything off the record about a customer in this queue",
      ),
    }),
  },
);
type TextSpec = typeof textArb extends fc.Arbitrary<infer T> ? T : never;

const messageArb = fc.record({
  role: fc.constantFrom(...ROLES),
  text: textArb,
  shape: fc.constantFrom("string", "parts", "null"),
});
type MessageSpec = typeof messageArb extends fc.Arbitrary<infer T> ? T : never;

/** The last message leans towards user control messages so that every decision path is exercised. */
const lastMessageArb: fc.Arbitrary<MessageSpec> = fc.record({
  role: fc.oneof({ weight: 6, arbitrary: fc.constant("user" as const) }, { weight: 1, arbitrary: fc.constantFrom(...ROLES) }),
  text: fc.oneof({ weight: 4, arbitrary: textArb.filter((t) => t.type === "issued") }, { weight: 3, arbitrary: textArb }),
  shape: fc.oneof({ weight: 6, arbitrary: fc.constant("string" as const) }, { weight: 1, arbitrary: fc.constantFrom("parts", "null") }),
});

function weighted<T>(common: readonly T[], rare: readonly T[]): fc.Arbitrary<T> {
  return fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...common) }, { weight: 1, arbitrary: fc.constantFrom(...rare) });
}

const actionArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("issue" as const),
      session: fc.constantFrom(...SESSIONS),
      agent: fc.constantFrom<AgentRole>("interviewer", "tutor"),
      ttlMs: fc.integer({ min: 1, max: 8_000 }),
      text: fc.constantFrom("Why that threshold?", "What makes a supplier new?", "Walk me through it."),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("bump" as const), session: fc.constantFrom(...SESSIONS) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 5_000 }) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("request" as const),
      model: weighted(
        Object.keys(MODELS).filter((m) => MODELS[m]),
        Object.keys(MODELS).filter((m) => !MODELS[m]),
      ),
      session: weighted<string | null>(["s1", "s2"], ["s3", null]),
      history: fc.array(messageArb, { maxLength: 4 }),
      last: lastMessageArb,
      /** Cancel the response after its first chunk, as a dropped connection would (ElevenLabs then retries). */
      abort: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
    }),
  },
);

function resolveText(spec: TextSpec, issued: readonly RefAuth[]): string {
  const pick = (index: number) => issued[index % Math.max(issued.length, 1)]?.nonce ?? "B".repeat(43);
  switch (spec.type) {
    case "issued":
      return `${spec.pad}${formatControlMessage(pick(spec.index))}${spec.pad}`;
    case "forged":
      return formatControlMessage(Buffer.from(spec.bytes).toString("base64url"));
    case "near_miss": {
      const nonce = pick(spec.index);
      if (spec.form === "prefix") return `ok ${formatControlMessage(nonce)}`;
      if (spec.form === "suffix") return `${formatControlMessage(nonce)}.`;
      if (spec.form === "brackets") return `[ctl:${nonce}]`;
      if (spec.form === "truncated") return formatControlMessage(nonce.slice(0, 21));
      return formatControlMessage(nonce) + formatControlMessage(nonce);
    }
    case "free":
    case "phrase":
      return spec.text;
  }
}

/** The message, plus its plain text as the wrapper reads it (null content reads as ""). */
function toMessage(spec: MessageSpec, issued: readonly RefAuth[]): { role: string; content: unknown; text: string } {
  const text = resolveText(spec.text, issued);
  if (spec.shape === "null") return { role: spec.role, content: null, text: "" };
  if (spec.shape === "parts") return { role: spec.role, content: [{ type: "text", text }], text };
  return { role: spec.role, content: text, text };
}

describe("custom-LLM wrapper invariant (property)", () => {
  it("never speaks without a fresh, valid authorization, and then speaks exactly its text once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 16 }), async (actions) => {
        const h = createHarness();
        try {
          for (const id of SESSIONS) h.ledger.createSession({ id });
          const issued: RefAuth[] = [];
          const spoken = new Set<string>();
          const seen = new Set<string>();
          const versions = new Map<string, number>();
          /** Requests naming a session that exists in the ledger, so each must leave one decision entry. */
          let recordable = 0;
          let abortedSpeeches = 0;
          /** Off-record replies to a known session: each leaves exactly one marker and no decision. */
          let offRecordMarkers = 0;

          for (const action of actions) {
            if (action.kind === "issue") {
              const contextVersion = versions.get(action.session) ?? 0;
              const auth = h.authorizations.issue({
                sessionId: action.session,
                agent: action.agent,
                questionId: "q",
                text: action.text,
                contextVersion,
                ttlMs: action.ttlMs,
              });
              issued.push({ ...auth, agent: action.agent, text: action.text });
              continue;
            }
            if (action.kind === "bump") {
              versions.set(action.session, h.authorizations.bumpContextVersion(action.session));
              continue;
            }
            if (action.kind === "advance") {
              h.advance(action.ms);
              continue;
            }

            const last = toMessage(action.last, issued);
            const body = chatBody({
              model: action.model,
              messages: [...action.history.map((m) => toMessage(m, issued)), last].map(({ role, content }) => ({ role, content })),
              ...(action.session === null ? {} : { extraBody: { sessionId: action.session } }),
            });
            const nonce = last.role === "user" ? parseControlMessage(last.text) : null;
            const auth = nonce === null ? undefined : issued.find((a) => a.nonce === nonce);
            const agent = MODELS[action.model] ?? null;
            const valid =
              auth !== undefined &&
              h.now() < auth.expiresAt &&
              agent === auth.agent &&
              action.session === auth.sessionId &&
              (versions.get(auth.sessionId) ?? 0) === auth.contextVersion;
            const offRecordExpected = agent !== null && last.role === "user" && nonce === null && isOffRecordPhrase(last.text);

            const response = await h.call(body);
            const known = SESSIONS.some((s) => s === action.session);
            if (known && offRecordExpected) offRecordMarkers += 1;
            else if (known) recordable += 1;

            if (action.abort) {
              const reader = response.body?.getReader();
              const first = new TextDecoder().decode((await reader?.read())?.value);
              await reader?.cancel();
              expect(first.includes('"name":"set_off_record"')).toBe(offRecordExpected);
              if (first.includes('"role":"assistant","content":""')) {
                // Speech started: same safety as below; the nonce goes back for a retry, so it stays fresh.
                expect(valid).toBe(true);
                expect(spoken.has(nonce ?? "")).toBe(false);
                abortedSpeeches += 1;
                continue;
              }
              if (valid && nonce !== null && !seen.has(nonce)) throw new Error("valid first presentation skipped");
              if (nonce !== null) seen.add(nonce);
              continue;
            }

            const turn = await readTurn(response);
            // Silencing: exactly for an off-record phrase from a known agent; readTurn already proved no content.
            expect(turn.kind === "off_record").toBe(offRecordExpected);
            if (turn.kind === "speech") {
              // Safety: speech only for a valid authorization that has not spoken, with its exact text.
              expect(valid).toBe(true);
              expect(spoken.has(nonce ?? "")).toBe(false);
              expect(turn.text).toBe(auth?.text);
              spoken.add(nonce ?? "");
              // A second identical request skips.
              expect(await readTurn(await h.call(body))).toMatchObject({ kind: "skip", reason: "already_used" });
              if (known) recordable += 1;
            } else if (turn.kind === "skip" && valid && nonce !== null && !seen.has(nonce)) {
              // Liveness: a valid nonce presented for the first time (or retried after an aborted
              // stream) is never silenced.
              throw new Error(`valid first presentation skipped: ${turn.reason}`);
            }
            if (nonce !== null) seen.add(nonce);
          }

          // Every request to a known session left exactly one decision; no control entry is evidence.
          const decisions = SESSIONS.flatMap((s) => h.ledger.list(s, { kinds: ["llm.turn_decision"] }));
          const speeches = decisions.filter((e) => (e.payload as { decision: string }).decision === "speak");
          expect(speeches).toHaveLength(spoken.size + abortedSpeeches);
          const aborts = SESSIONS.flatMap((s) => h.ledger.list(s, { kinds: ["llm.stream_aborted"] }));
          expect(aborts).toHaveLength(abortedSpeeches);
          expect(decisions).toHaveLength(recordable);
          const markers = SESSIONS.flatMap((s) => h.ledger.list(s, { kinds: ["privacy.phrase_detected"] }));
          expect(markers).toHaveLength(offRecordMarkers);
          expect(markers.every((e) => e.source === "system_control")).toBe(true);
          for (const s of SESSIONS) expect(h.ledger.evidence(s).every((e) => e.source !== "system_control")).toBe(true);
        } finally {
          h.opened.close();
        }
      }),
      RUNS,
    );
  });
});
