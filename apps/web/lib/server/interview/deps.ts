import { engineConfig } from "@vashistha/core";
import { replyBySpeech } from "../debrief/conversation";
import { debriefDeps } from "../debrief/runtime-deps";
import { getRuntime } from "../runtime";
import { schemaDeps } from "../schema/runtime-deps";
import { replyBySpeech as coachBySpeech } from "../tutor/conversation";
import { tutorDeps } from "../tutor/deps";
import type { InterviewDeps } from "./orchestrator";

/** Engine knobs in force: the engine's defaults (plan §7.3; heuristics, labelled as such on the HUD). */
const ENGINE_CONFIG = engineConfig();

/** A process timer that never keeps the server alive on its own. */
function schedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

/** The interview handlers' dependencies, from the process runtime (route adapters and CaseDesk deps only). */
export function interviewDeps(): InterviewDeps {
  const { ledger, casedesk, interview, authorizations, claude, rulebookAllModels, engine } = getRuntime();
  return {
    ledger,
    casedesk,
    store: interview,
    authorizations,
    claude,
    config: ENGINE_CONFIG,
    questions: engine.questions,
    rulebook: rulebookAllModels,
    now: Date.now,
    schedule,
    // A spoken reply to a debrief conversation turn is the expert's reply in that conversation (same ledger and stores).
    debriefAnswer: (input) => replyBySpeech({ debrief: debriefDeps(), schema: schemaDeps() }, input),
    // What a trainee says in a novice session is answered by the voice coach (same ledger, the tutor's rulebook).
    coachReply: (input) => coachBySpeech(tutorDeps(), input),
    log: console,
  };
}
