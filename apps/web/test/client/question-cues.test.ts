import { describe, expect, it } from "vitest";
import type { Question } from "@vashistha/core";
import {
  createCueScheduler,
  cueFor,
  featureTargets,
  runCue,
  witnessTarget,
  type CueDom,
  type CueElement,
  type CueResult,
} from "../../lib/client/voice/question-cues";

type Target = Question["target"];
const q = (kind: Question["kind"], target: Partial<Target> = {}) => ({ kind, target: { candidateIds: [], ...target } as Target });

/** A DOM of elements carrying the markup attributes, matched like the browser's attribute selectors. */
function fakeDom(elements: Record<string, string>[]) {
  const log: string[] = [];
  const asElement = (i: number): CueElement => ({
    scrollIntoView: (options) => log.push(`scroll ${i} ${options.block ?? ""}`),
    animate: (_keyframes, options) => log.push(`flash ${i} ${String(options.duration)}`),
  });
  const dom: CueDom = {
    findAll(selector) {
      const features = /^\[data-features~="([^"]+)"\]$/.exec(selector)?.[1];
      const witness = /^\[data-witness-id="([^"]+)"\]$/.exec(selector)?.[1];
      return elements.flatMap((attrs, i) => {
        const hit =
          (features !== undefined && (attrs["data-features"] ?? "").split(" ").includes(features)) ||
          (witness !== undefined && attrs["data-witness-id"] === witness);
        return hit ? [asElement(i)] : [];
      });
    },
  };
  return { dom, log };
}

describe("cueFor", () => {
  it("highlights the target feature of a counterfactual and shows the gap of a witness question", () => {
    expect(cueFor(q("counterfactual", { feature: "uboOwnershipPct" as Target["feature"] }))).toEqual({
      action: "highlight_field",
      feature: "uboOwnershipPct",
    });
    expect(cueFor(q("witness", { witnessId: "w-1", feature: "pep" as Target["feature"] }))).toEqual({ action: "show_gap", witnessId: "w-1" });
  });

  it.each([
    ["why_probe", {}],
    ["concept_definition", {}],
    ["teach_back", {}],
    ["prediction", {}],
    ["intervention", {}],
    ["counterfactual", {}],
    ["witness", {}],
  ] as const)("has no cue for %s %j", (kind, target) => {
    expect(cueFor(q(kind, target))).toBeNull();
  });
});

describe("runCue", () => {
  it("scrolls to the first element showing the feature and flashes every one", () => {
    const { dom, log } = fakeDom([featureTargets("entityType"), featureTargets("uboOwnershipPct", "pep"), featureTargets("pep")]);
    const result = runCue({ action: "highlight_field", feature: "pep" }, dom, 5);
    expect(result).toEqual({ action: "highlight_field", shown: true, at: 5, message: "Highlighted “Politically exposed person” in the case file" });
    expect(log).toEqual(["scroll 1 center", "flash 1 2400", "flash 2 2400"]);
  });

  it("says when the feature is not on screen, and never builds a selector from an unsafe id", () => {
    const { dom, log } = fakeDom([featureTargets("entityType")]);
    expect(runCue({ action: "highlight_field", feature: "pep" }, dom, 1)).toMatchObject({ shown: false, message: "“Politically exposed person” is not on screen" });
    expect(runCue({ action: "highlight_field", feature: 'x"] , *' }, dom, 1).shown).toBe(false);
    expect(log).toEqual([]);
  });

  it("shows a solver gap on the debrief, or says where it will be reviewed", () => {
    const { dom, log } = fakeDom([witnessTarget("w-1")]);
    expect(runCue({ action: "show_gap", witnessId: "w-1" }, dom, 1)).toMatchObject({ shown: true, message: "Showing the solver gap this question closes" });
    expect(runCue({ action: "show_gap", witnessId: "w-2" }, dom, 1)).toMatchObject({
      shown: false,
      message: "This question closes a solver gap — review it in the debrief",
    });
    expect(log).toEqual(["scroll 0 center", "flash 0 2400"]);
  });
});

describe("createCueScheduler", () => {
  function setup() {
    const { dom, log } = fakeDom([featureTargets("jurisdictionRisk")]);
    const results: CueResult[] = [];
    const scheduler = createCueScheduler({ dom, now: () => 42, onCue: (r) => results.push(r) });
    return { scheduler, results, log };
  }
  const counterfactual = q("counterfactual", { feature: "jurisdictionRisk" as Target["feature"] });

  it("runs the cue once, when the agent starts speaking the authorised question", () => {
    const { scheduler, results, log } = setup();
    scheduler.armed(counterfactual);
    scheduler.agentMode("listening");
    expect(results).toEqual([]);
    scheduler.agentMode("speaking");
    scheduler.agentMode("listening");
    scheduler.agentMode("speaking");
    expect(results).toEqual([{ action: "highlight_field", shown: true, at: 42, message: "Highlighted “Country risk (Northstar list)” in the case file" }]);
    expect(log).toHaveLength(2);
  });

  it("shows nothing for a question that was never spoken (disconnect) or that has no cue", () => {
    const { scheduler, results } = setup();
    scheduler.armed(counterfactual);
    scheduler.reset();
    scheduler.agentMode("speaking");
    scheduler.armed(counterfactual);
    scheduler.armed(q("why_probe"));
    scheduler.agentMode("speaking");
    expect(results).toEqual([]);
  });
});
