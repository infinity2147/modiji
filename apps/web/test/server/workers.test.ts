/**
 * The compute worker threads (lib/server/workers): the RPC client's queue, timeout, crash and urgency
 * semantics, and that the Z3 and engine workers return exactly what the same functions return in
 * process (same witnesses, same questions, ids included).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  EMPTY_KNOWLEDGE,
  PredicateSchema,
  RuleEffectSchema,
  buildHypothesisSet,
  engineConfig,
  familyModel,
  observeDecision,
  type ConfirmedRule,
  type FamilyKnowledge,
  type HypothesisSet,
  type RecentDecision,
} from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import { findDisagreements, practiceCases, searchWitnesses } from "@vashistha/solver";
import { createRgba, thumbnail, type RgbaImage } from "@vashistha/perception";
import type { CaseSnapshot, PreparedRead } from "@vashistha/perception/extraction";
import { encodePng } from "@vashistha/perception/png";
import { z } from "zod";
import { createRpcWorker, WorkerTaskError, WorkerTimeoutError, WorkerUnavailableError, type RpcClient } from "../../lib/server/workers/client";
import { createEngineWorker, type EngineWorker } from "../../lib/server/workers/engine";
import { prepareFrame, type FrameToRead } from "../../lib/server/perception/prepare";
import { CASEDESK_SCREEN } from "../../lib/server/perception/screen-profile";
import { createVisionWorker, type VisionWorker } from "../../lib/server/workers/vision";
import { createZ3Worker, type Z3Worker } from "../../lib/server/workers/z3";
import { inProcessQuestions } from "../support/engine";
import { TEST_OPS } from "../support/rpc-test-ops";

const silent = { warn: () => undefined, error: () => undefined };

describe("RPC worker client", () => {
  let rpc: RpcClient<typeof TEST_OPS>;
  const spawn = (maxInFlight: number) =>
    createRpcWorker({ name: "test", entry: new URL("../support/rpc-test.worker.ts", import.meta.url), ops: TEST_OPS, maxInFlight, log: silent });
  afterAll(() => rpc.close());

  it("round-trips a validated request and response", async () => {
    rpc = spawn(2);
    expect(await rpc.call("echo", { text: "hello" })).toEqual({ text: "hello" });
  });

  it("rejects input the worker's schema refuses, a failing handler and an invalid output, and keeps serving", async () => {
    await expect(rpc.call("echo", { text: 7 } as unknown as { text: string })).rejects.toMatchObject({ name: "WorkerInputError" });
    const failed = rpc.call("fail", { text: "nope" });
    await expect(failed).rejects.toBeInstanceOf(WorkerTaskError);
    await expect(failed).rejects.toMatchObject({ name: "BoomError", message: "nope" });
    await expect(rpc.call("badOutput", {})).rejects.toMatchObject({ name: "WorkerOutputError" });
    expect(await rpc.call("echo", { text: "still here" })).toEqual({ text: "still here" });
  });

  it("times out a request, restarts the worker and re-dispatches the requests it had in flight", async () => {
    const slow = rpc.call("sleep", { ms: 10_000 });
    const victim = rpc.call("echo", { text: "victim" });
    await expect(slow).rejects.toBeInstanceOf(WorkerTimeoutError);
    expect(await victim).toEqual({ text: "victim" });
    expect(await rpc.call("echo", { text: "after" })).toEqual({ text: "after" });
  });

  it("fails what a dying worker had in flight and serves the queue on a new one", async () => {
    await expect(rpc.call("exit", {})).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(await rpc.call("echo", { text: "reborn" })).toEqual({ text: "reborn" });
  });

  it("dispatches urgent requests ahead of queued ones", async () => {
    await rpc.close();
    rpc = spawn(1);
    await rpc.call("echo", { text: "warm" });
    const order: string[] = [];
    const track = (p: Promise<{ text: string }>) => p.then((r) => void order.push(r.text));
    const done = [
      track(rpc.call("sleep", { ms: 100 })),
      track(rpc.call("echo", { text: "first queued" })),
      track(rpc.call("echo", { text: "second queued" })),
      track(rpc.call("ping", { text: "urgent" })),
    ];
    await Promise.all(done);
    expect(order).toEqual(["slept 100", "urgent", "first queued", "second queued"]);
  });

  it("fails queued and in-flight requests on close", async () => {
    const settled = [rpc.call("sleep", { ms: 200 }), rpc.call("echo", { text: "never" })].map((p) => expect(p).rejects.toBeInstanceOf(WorkerUnavailableError));
    await rpc.close();
    await Promise.all(settled);
    await expect(rpc.call("echo", { text: "closed" })).rejects.toBeInstanceOf(WorkerUnavailableError);
  });
});

const v = (id: string) => ({ var: id });
const effect = (type: "recommend" | "forbid", action: string): ConfirmedRule["effect"] => RuleEffectSchema.parse({ type, action });

function confirmed(id: string, predicate: unknown, effect: ConfirmedRule["effect"], priority: number, expertId: string, kind: ConfirmedRule["kind"] = "decision"): ConfirmedRule {
  return {
    id,
    decisionFamily: "reviewOutcome",
    kind,
    predicate: PredicateSchema.parse(predicate),
    effect,
    priority,
    overrides: [],
    evidence: [
      {
        kind: "expert_quote",
        utteranceId: `u-${id}`,
        exactQuote: `The expert's words for ${id}.`,
        t0Ms: 0,
        t1Ms: 1000,
        frameIds: [`f-${id}`],
        eventIds: [],
        relation: "supports",
        provenance: "human_voice",
      },
    ],
    confirmedBy: [{ expertId, at: 1_791_000_000_000, method: "explicit_statement", ledgerEntryId: `u-${id}` }],
    revision: 1,
    schemaVersion: 1,
    expertId,
  };
}

const ASHA = [
  confirmed("rule_ubo", { and: [{ ">": [v("uboOwnershipPct"), 25] }, { "==": [v("uboVerified"), false] }] }, effect("recommend", "enhancedReview"), 10, "asha-rao"),
  confirmed("rule_pep", { "==": [v("pep"), true] }, effect("recommend", "escalateCompliance"), 20, "asha-rao", "escalation"),
  confirmed("rule_docs", { "==": [v("sourceOfFunds"), "not_provided"] }, effect("recommend", "requestDocuments"), 10, "asha-rao"),
  confirmed("rule_stop", { and: [{ "==": [v("jurisdictionRisk"), "high"] }, { "<": [v("accountAgeMonths"), 24] }] }, effect("forbid", "approve"), 40, "asha-rao", "guardrail"),
];
const PRIYA = [
  confirmed("rule_high", { "==": [v("jurisdictionRisk"), "high"] }, effect("recommend", "enhancedReview"), 10, "priya-sharma"),
  confirmed("rule_ubo40", { ">": [v("uboOwnershipPct"), 40] }, effect("recommend", "enhancedReview"), 10, "priya-sharma"),
];

describe("Z3 worker", () => {
  let z3: Z3Worker;
  beforeAll(() => {
    z3 = createZ3Worker(silent);
  });
  afterAll(() => z3.close());

  it("passes the self-test", { timeout: 60_000 }, async () => {
    expect(await z3.selfTest()).toMatchObject({ ok: true, ms: expect.any(Number) });
  });

  it("finds exactly the witnesses, disagreements and practice cases the solver finds in process", { timeout: 120_000 }, async () => {
    const search = { domain: KYC_DOMAIN, rules: ASHA, families: ["reviewOutcome"], schemaVersion: 1 };
    const witnesses = await z3.witnesses(search);
    expect(witnesses.witnesses.length).toBeGreaterThan(0);
    expect(witnesses).toEqual(await searchWitnesses(search));

    const pair = { domain: KYC_DOMAIN, rulesA: ASHA, rulesB: PRIYA, experts: ["asha-rao", "priya-sharma"] as const, family: "reviewOutcome", schemaVersion: 1 };
    const disagreements = await z3.disagreements(pair);
    expect(disagreements.length).toBeGreaterThan(0);
    expect(disagreements).toEqual(await findDisagreements(pair));

    const practice = { domain: KYC_DOMAIN, rules: ASHA, ruleIds: ["rule_ubo", "rule_stop"], count: 3, schemaVersion: 1 };
    const cases = await z3.practice(practice);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases).toEqual(await practiceCases(practice));
  });

  it("refuses an invalid query at the boundary and reports solver errors by name", { timeout: 60_000 }, async () => {
    const badRule = { ...ASHA[0], evidence: [] } as unknown as ConfirmedRule;
    await expect(z3.witnesses({ domain: KYC_DOMAIN, rules: [badRule], families: ["reviewOutcome"], schemaVersion: 1 })).rejects.toMatchObject({
      name: "WorkerInputError",
    });
    await expect(z3.witnesses({ domain: KYC_DOMAIN, rules: ASHA, families: ["noSuchFamily"], schemaVersion: 1 })).rejects.toBeInstanceOf(WorkerTaskError);
  });
});

describe("engine worker", () => {
  let engine: EngineWorker;
  beforeAll(() => {
    engine = createEngineWorker(silent);
  });
  afterAll(() => engine.close());

  it("generates exactly the questions the engine generates in process", { timeout: 60_000 }, async () => {
    const config = engineConfig();
    const model = familyModel(KYC_DOMAIN, "reviewOutcome", config);
    let set: HypothesisSet = buildHypothesisSet({ setId: "hs_test", model, knowledge: EMPTY_KNOWLEDGE, schemaVersion: 1, config });
    let knowledge: FamilyKnowledge = EMPTY_KNOWLEDGE;
    let recent: RecentDecision | undefined;
    const decided: [string, string][] = [
      ["NS-2026-0101", "requestDocuments"],
      ["NS-2026-0102", "approve"],
      ["NS-2026-0103", "enhancedReview"],
    ];
    for (const [caseId, action] of decided) {
      const kycCase = findKycCase(caseId);
      if (kycCase === undefined) throw new Error(`no case ${caseId}`);
      const step = observeDecision({ model, set, knowledge, observation: { id: `d-${caseId}`, caseId, features: caseFeatures(kycCase, {}), action: ActionIdSchema.parse(action) }, config });
      ({ set, knowledge, recent } = step);
    }
    if (recent === undefined) throw new Error("no decision observed");
    const input = {
      domain: KYC_DOMAIN,
      familyId: "reviewOutcome",
      set,
      ctx: {
        sessionId: "s-engine-worker",
        createdAt: 1_791_000_000_000,
        contextVersion: 3,
        caseId: "NS-2026-0103",
        context: {
          case: recent.observation.features,
          workflow: { priorActions: [] },
          history: { derived: {} },
          actor: { role: "reviewer", id: "expert" },
          environment: { date: "2026-10-04" },
          schemaVersion: 1,
        },
        parentIds: ["d-NS-2026-0103"],
      },
      recent,
      concepts: [{ name: "documentAge", label: "Document age", definition: "How old the identity documents are", type: "number" as const }],
      config,
    };
    const questions = await engine.questions(input);
    expect(questions.length).toBeGreaterThan(1);
    expect(questions).toEqual(await inProcessQuestions(input));
  });
});

describe("vision worker", () => {
  let vision: VisionWorker;
  beforeAll(() => {
    vision = createVisionWorker(silent);
  });
  afterAll(() => vision.close());

  const W = 960;
  const H = 540;
  /** A case page with blank margins (a whole-screen read trims them) and one highlighted row. */
  function page(row: number): RgbaImage {
    const image = createRgba(W, H);
    image.data.fill(255);
    const fill = (x0: number, y0: number, w: number, h: number, shade: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) image.data.set([shade, shade, shade + 20, 255], (y * W + x) * 4);
    };
    fill(120, 60, 720, 40, 40);
    for (let r = 0; r < 8; r++) fill(140, 130 + r * 44, 300, 18, r === row ? 30 : 190);
    return image;
  }
  const encoded = (image: RgbaImage) => ({ base64Png: encodePng(image).toString("base64"), width: image.width, height: image.height });
  /** Everything but the output schema, which is a zod object; schemas are compared as JSON Schema. */
  const comparable = (read: PreparedRead) => ({ ...read, request: { ...read.request, schema: z.toJSONSchema(read.request.schema) } });

  it("plans exactly the read the perception code plans in process (whole screen and local)", { timeout: 60_000 }, async () => {
    const first = page(1);
    const base: Omit<FrameToRead, "frame" | "previous" | "crop"> = { domain: KYC_DOMAIN, profile: CASEDESK_SCREEN, frameSeq: 1, captureTime: 1_000, sessionEpoch: 0 };
    const screen: FrameToRead = { ...base, previous: null, frame: { ...encoded(first), sourceWidth: W, sourceHeight: H }, crop: null };
    const whole = await vision.prepare(screen);
    expect(whole.mode).toBe("refresh");
    expect(comparable(whole)).toEqual(comparable(prepareFrame(screen)));

    const previous: CaseSnapshot = {
      caseId: "NS-2026-0101",
      fields: {},
      committed: null,
      thumbnail: thumbnail(first),
      fullReadAt: 1_000,
      conceptsRead: true,
      caseVotes: { "NS-2026-0101": 1 },
      caseTitle: "Northwind Trading",
    };
    const changed: FrameToRead = { ...base, frameSeq: 2, captureTime: 2_000, previous, frame: { ...encoded(page(5)), sourceWidth: W, sourceHeight: H }, crop: null };
    const local = await vision.prepare(changed);
    expect(local.mode).toBe("local");
    expect(comparable(local)).toEqual(comparable(prepareFrame(changed)));
    expect(local.context.previous).toBe(previous);
  });

  it("refuses a frame that is not a PNG with the perception code's own error", { timeout: 60_000 }, async () => {
    const bad: FrameToRead = {
      domain: KYC_DOMAIN,
      profile: CASEDESK_SCREEN,
      previous: null,
      frameSeq: 1,
      captureTime: 1,
      sessionEpoch: 0,
      frame: { base64Png: Buffer.from("not a png").toString("base64"), width: 10, height: 10, sourceWidth: 10, sourceHeight: 10 },
      crop: null,
    };
    expect(() => prepareFrame(bad)).toThrow();
    await expect(vision.prepare(bad)).rejects.toBeInstanceOf(WorkerTaskError);
  });
});
