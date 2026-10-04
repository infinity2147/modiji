import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineConfig, parseLedgerPayload } from "@vashistha/core";
import { createClaude, type ClaudeClient } from "@vashistha/core/server";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { DebriefConversationSchema, type DebriefConversation } from "../../lib/contracts/debrief";
import type { ConversationDeps } from "../../lib/server/debrief/conversation";
import { handleConversation, handleGetConversation } from "../../lib/server/debrief/handlers";
import type { LlmDebriefReply } from "../../lib/server/debrief/interpret";
import { TEACHBACK_SYSTEM } from "../../lib/server/debrief/teachback";
import { createSchemaStore } from "../../lib/server/schema/deps";
import { jsonRequest } from "../support/casedesk-harness";
import { OPUS_TEACHBACK, message, path, reply, world, type World } from "../support/debrief-harness";

const EMPTY: LlmDebriefReply = { kind: "unclear", combinator: "all", conditions: [], action: "", effect: "none", role: "", rule: "none", min: 0, max: 0, integer: false };
const SANCTIONS = "Never approve anyone with a sanctions hit, full stop.";
const PEP_SIGNOFF = "A politically exposed person can only be approved with compliance sign-off.";
const MEDIUM_RISK = "Medium-risk country and an owner over 30% means enhanced review for me.";
const INVENTED = "Anyone with a weird vibe gets rejected.";

/** What the fake model says each reply means (the conversation never sends plain yes / no / skip to it). */
const READINGS: Record<string, LlmDebriefReply> = {
  [SANCTIONS]: { ...EMPTY, kind: "stop_rule", conditions: [{ feature: "sanctionsHit", op: "==", value: true }], action: "approve", effect: "forbid" },
  [PEP_SIGNOFF]: { ...EMPTY, kind: "stop_rule", conditions: [{ feature: "pep", op: "==", value: true }], action: "approve", effect: "require_approval", role: "compliance_officer" },
  [MEDIUM_RISK]: {
    ...EMPTY,
    kind: "decision_rule",
    conditions: [
      { feature: "jurisdictionRisk", op: "==", value: "medium" },
      { feature: "uboOwnershipPct", op: ">", value: 30 },
    ],
    action: "enhancedReview",
  },
  // The model invents a feature: code turns this into "unclear", never a rule.
  [INVENTED]: { ...EMPTY, kind: "decision_rule", conditions: [{ feature: "vibe", op: "==", value: "weird" }], action: "reject" },
};

type Call = { system: string; reply: string };

function fakeModel(calls: Call[]): ClaudeClient {
  return {
    messages: {
      create: async (params) => {
        const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
        if (system === TEACHBACK_SYSTEM) return message(OPUS_TEACHBACK);
        if (system.startsWith("You read an expert's reply")) {
          const user = params.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("");
          const expertReply = (JSON.parse(user) as { expertReply: string }).expertReply;
          calls.push({ system, reply: expertReply });
          return message(JSON.stringify(READINGS[expertReply] ?? EMPTY));
        }
        throw new Error("unexpected prompt");
      },
    },
  };
}

let w: World;
let deps: ConversationDeps;
let modelCalls: Call[];

beforeEach(async () => {
  w = await world();
  modelCalls = [];
  w.deps.claude = createClaude({ client: fakeModel(modelCalls), forbiddenMarkers: [ORACLE_MARKER] });
  deps = {
    debrief: w.deps,
    schema: { ledger: w.ledger, casedesk: w.deps.casedesk, interview: w.deps.interview, engineConfig: engineConfig(), reread: null, store: createSchemaStore(), now: () => 1_760_000_000_000, log: w.deps.log },
  };
});

afterEach(async () => {
  w.opened.close();
  await rm(w.dataDir, { recursive: true, force: true });
});

async function post(body: unknown): Promise<{ status: number; body: unknown }> {
  return reply(await handleConversation(jsonRequest(path(w.sessionId, "debrief/conversation"), body), w.sessionId, deps));
}

async function say(text: string): Promise<DebriefConversation> {
  const r = await post({ type: "reply", text });
  if (r.status !== 200) throw new Error(`reply failed: ${r.status} ${JSON.stringify(r.body)}`);
  return DebriefConversationSchema.parse(r.body);
}

async function start(): Promise<DebriefConversation> {
  const r = await post({ type: "start" });
  expect(r.status).toBe(200);
  return DebriefConversationSchema.parse(r.body);
}

/** Skips every question until one about `topic` is waiting. */
async function skipTo(c: DebriefConversation, topic: string): Promise<DebriefConversation> {
  for (let i = 0; i < 40 && c.awaiting !== null && c.awaiting.topic !== topic; i += 1) c = await say("skip");
  expect(c.awaiting?.topic).toBe(topic);
  return c;
}

const kinds = (): string[] => w.ledger.list(w.sessionId).map((e) => e.kind);

describe("debrief conversation", () => {
  it("opens with a question, records it in the ledger, and a GET never writes", async () => {
    const before = kinds().length;
    const g = DebriefConversationSchema.parse((await reply(await handleGetConversation(w.sessionId, deps))).body);
    expect(g.turns).toEqual([]);
    expect(kinds().length).toBe(before);

    const c = await start();
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0]?.role).toBe("agent");
    expect(c.turns[0]?.text).toMatch(/^Let's go over what I learned/);
    expect(c.awaiting).not.toBeNull();
    expect(kinds()).toContain("debrief.asked");

    // Starting again while a question waits asks nothing new.
    const again = await start();
    expect(again.turns).toHaveLength(1);
  });

  it("skipping everything ends with the closing line and saves nothing", async () => {
    const rulesBefore = (await start()).state.rules.length;
    let c = await say("skip");
    for (let i = 0; i < 40 && !c.done; i += 1) c = await say("skip");
    expect(c.done).toBe(true);
    expect(c.awaiting).toBeNull();
    expect(c.turns.at(-1)?.text).toMatch(/That's everything I needed/);
    expect(c.state.rules).toHaveLength(rulesBefore);
    expect(c.turns.filter((t) => t.role === "expert").every((t) => t.outcome?.saved === false)).toBe(true);
    expect(modelCalls).toHaveLength(0);
  });

  it("a hard stop said in plain words is read back, and saved only after a plain yes, with the expert's own words as the quote", async () => {
    let c = await skipTo(await start(), "stop_rules");
    const rulesBefore = c.state.rules.length;

    c = await say(SANCTIONS);
    expect(c.awaiting?.topic).toBe("readback");
    expect(c.awaiting?.text).toBe("So the hard stop is: when sanctions screening match is yes, never approve onboarding. Save it?");
    expect(c.state.rules).toHaveLength(rulesBefore);
    expect(c.turns.at(-2)?.outcome).toEqual({ readAs: "statement", byModel: true, saved: false, refused: null });

    c = await say("Yes, that's right.");
    expect(c.state.rules).toHaveLength(rulesBefore + 1);
    const saved = c.state.rules.find((r) => r.rule.kind === "guardrail" && JSON.stringify(r.rule.predicate).includes("sanctionsHit"));
    expect(saved?.rule.evidence[0]).toMatchObject({ kind: "expert_quote", exactQuote: SANCTIONS, provenance: "human_text" });
    expect(c.turns.at(-2)?.outcome).toMatchObject({ readAs: "yes", byModel: false, saved: true });
    // It asks for another one.
    expect(c.awaiting?.topic).toBe("stop_rules");
    expect(c.awaiting?.text).toMatch(/^Saved\. Any other hard stop\?/);
  });

  it("a sign-off rule becomes require_approval for the named role", async () => {
    await skipTo(await start(), "stop_rules");
    let c = await say(PEP_SIGNOFF);
    expect(c.awaiting?.text).toMatch(/compliance officer/i);
    c = await say("Yes");
    const rule = c.state.rules.find((r) => r.rule.effect.type === "require_approval");
    expect(rule?.rule.effect).toEqual({ type: "require_approval", role: "compliance_officer", action: "approve" });
  });

  it("no to a read-back saves nothing and asks again", async () => {
    let c = await skipTo(await start(), "stop_rules");
    const rulesBefore = c.state.rules.length;
    await say(SANCTIONS);
    c = await say("No");
    expect(c.state.rules).toHaveLength(rulesBefore);
    expect(c.awaiting?.text).toMatch(/^Okay, not saved\. Tell me again in your own words, or say skip\.$/);
  });

  it("a reading that names a feature the domain does not have is not a rule: asked once more, then moved on", async () => {
    let c = await skipTo(await start(), "stop_rules");
    const rulesBefore = c.state.rules.length;
    c = await say(INVENTED);
    expect(c.awaiting?.text).toMatch(/^Sorry, I couldn't match that to the case fields\. /);
    expect(c.turns.at(-2)?.outcome).toMatchObject({ readAs: "unclear", saved: false });
    c = await say(INVENTED);
    expect(c.awaiting?.text).toMatch(/^I still couldn't tell, so let's move on\./);
    expect(c.state.rules).toHaveLength(rulesBefore);
  });

  it("explains an unexplained decision in plain words, read back and confirmed as a decision rule", async () => {
    let c = await skipTo(await start(), "unexplained");
    const rulesBefore = c.state.rules.length;
    c = await say(MEDIUM_RISK);
    expect(c.awaiting?.text).toMatch(/^So the rule is: when .*medium.*30.*, send to enhanced review\. Save it\?$/i);
    c = await say("Yes");
    expect(c.state.rules).toHaveLength(rulesBefore + 1);
    const stated = w.ledger.list(w.sessionId).filter((e) => e.kind === "expert.statement").at(-1);
    expect(stated === undefined ? undefined : parseLedgerPayload(stated, "expert.statement")).toMatchObject({ intent: "confirm_stated_rule", text: MEDIUM_RISK });
  });

  it("confirms the teach-back with a plain yes", async () => {
    let c = await skipTo(await start(), "teach_back");
    expect(c.awaiting?.text).toContain(OPUS_TEACHBACK);
    c = await say("Yes, exactly.");
    expect(c.state.teachBack?.confirmedEntryId).not.toBeNull();
    expect(c.done).toBe(true);
  });

  it("without a language model, only yes / no / skip are understood, and it says so", async () => {
    deps.debrief.claude = null;
    let c = await skipTo(await start(), "stop_rules");
    expect(c.llmAvailable).toBe(false);
    c = await say(SANCTIONS);
    expect(c.awaiting?.text).toMatch(/I can only understand yes, no and skip right now/);
  });

  it("refuses a reply before the conversation has started", async () => {
    const r = await post({ type: "reply", text: "hello" });
    expect(r.status).toBe(409);
  });
});
