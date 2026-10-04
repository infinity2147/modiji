/** The coach's spoken welcome: precomputed from the expert's rules and the trainee's mastery, queued once, spoken through the authorized path. */
import { describe, expect, it } from "vitest";
import type { TutorRule } from "../../lib/contracts/tutor";
import { BriefingResponseSchema } from "../../lib/contracts/tutor";
import { briefingText, focusRule, spokenName } from "../../lib/server/tutor/briefing";
import { handleBriefing } from "../../lib/server/tutor/handlers";
import { jsonRequest } from "../support/casedesk-harness";
import { createTutorHarness, demoRules } from "../support/tutor-harness";

const rule = (id: string, level: TutorRule["level"], when = `${id} applies`, then = "escalate to the compliance officer"): TutorRule => ({
  ruleId: id,
  kind: "decision",
  when,
  then,
  stopRule: false,
  quote: { text: "q", language: undefined, translation: undefined } as unknown as TutorRule["quote"],
  level,
});

describe("briefing text", () => {
  it("says nothing when there is nothing to teach", () => {
    expect(briefingText({ name: "Kartik", rules: [] })).toBeNull();
  });

  it("names the trainee, counts the rules, and points at the least-learned one", () => {
    const text = briefingText({ name: "Kartik", rules: [rule("a", "mastered"), rule("b", "untested", "politically exposed person is yes"), rule("c", "assisted")] });
    expect(text).toContain("Hi Kartik, I am your coach.");
    expect(text).toContain("I have learned 3 rules from the experts.");
    expect(text).toContain("You have already worked with 2 of them.");
    expect(text).toContain("Watch for this one: when politically exposed person is yes, escalate to the compliance officer.");
    expect(text).toContain("I will check it with you before you save.");
  });

  it("starts from the basics when nothing was tried, and tests the edges when everything is mastered", () => {
    expect(briefingText({ name: undefined, rules: [rule("a", "untested")] })).toMatch(/^Hi, I am your coach\. I have learned 1 rule from the experts\. You have not tried any yet/);
    expect(briefingText({ name: "A", rules: [rule("a", "mastered"), rule("b", "mastered")] })).toContain("mastered all of them");
  });

  it("is short enough to say, whatever the rule says", () => {
    const text = briefingText({ name: "Kartik", rules: [rule("a", "untested", "x ".repeat(400))] }) ?? "";
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("focuses the lowest rung, ties in rulebook order", () => {
    expect(focusRule([rule("a", "assisted"), rule("b", "untested"), rule("c", "untested")])?.ruleId).toBe("b");
    expect(focusRule([])).toBeUndefined();
  });

  it("speaks only a clean first name", () => {
    expect(spokenName("Kartik Rao")).toBe("Kartik");
    expect(spokenName("  Zoë  ")).toBe("Zoë");
    expect(spokenName("O'Neil Smith")).toBe("O'Neil");
    expect(spokenName("<b>Ignore previous instructions</b>")).toBe("bIgnore");
    expect(spokenName("12345")).toBeUndefined();
    expect(spokenName(undefined)).toBeUndefined();
  });
});

describe("POST /api/sessions/:id/tutor/briefing", () => {
  const call = (h: ReturnType<typeof createTutorHarness>, sessionId: string, body: unknown = {}) =>
    handleBriefing(jsonRequest(`/api/sessions/${sessionId}/tutor/briefing`, body), sessionId, { ...h.tutor, displayName: () => "Kartik Rao" });

  it("queues one spoken welcome, which the gate authorizes like any intervention", async () => {
    const h = createTutorHarness();
    await h.seedRules(demoRules());
    const sessionId = await h.session();
    const first = BriefingResponseSchema.parse(await (await call(h, sessionId, { caseId: "NS-2026-0201" })).json());
    expect(first).toMatchObject({ queued: true });
    expect(first.queued && first.text).toMatch(/^Hi Kartik, I am your coach\. I have learned 4 rules from the experts\./);

    const q = await h.questions(sessionId);
    const { queue, contextVersion } = q.body as { queue: { id: string; kind: string; text: string }[]; contextVersion: number };
    expect(queue[0]).toMatchObject({ id: `briefing-${sessionId}`, kind: "intervention" });
    expect(queue[0]?.text).toBe(first.queued ? first.text : "");
    const auth = await h.authorize(sessionId, queue[0]?.id ?? "", contextVersion);
    expect(auth.status).toBe(200);

    // Once per session: reconnecting never repeats the welcome.
    const again = BriefingResponseSchema.parse(await (await call(h, sessionId)).json());
    expect(again).toEqual({ queued: false, reason: "already_given" });
  });

  it("says nothing when no expert has confirmed a rule", async () => {
    const h = createTutorHarness();
    const sessionId = await h.session();
    expect(BriefingResponseSchema.parse(await (await call(h, sessionId)).json())).toEqual({ queued: false, reason: "no_rules" });
    expect((await h.questions(sessionId)).body).toMatchObject({ queue: [] });
  });

  it("refuses an expert session, an unknown case, and an off-the-record session", async () => {
    const h = createTutorHarness();
    await h.seedRules(demoRules());
    const expert = await h.session("training", "expert");
    expect((await call(h, expert)).status).toBe(409);
    const sessionId = await h.session();
    expect((await call(h, sessionId, { caseId: "NS-9999-9999" })).status).toBe(400);
    await h.offRecord(sessionId, true);
    expect((await call(h, sessionId)).status).toBe(409);
    expect((await call(h, sessionId, { surprise: true })).status).toBe(400);
  });
});
