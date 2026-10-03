import type { ActionId, Assignment } from "@vashistha/core";
import { absorb, EMPTY_KNOWLEDGE, observe, type Knowledge } from "../learner";
import type { BenchQuestion, ExpertAnswer, QuestionTiming, SimulatedExpert } from "../expert";

export type StreamCase = { caseId: string; features: Assignment };

/**
 * One episode as a strategy sees it: the training stream, the expert channel and the shared
 * learner's knowledge. Strategies differ ONLY in which questions they ask and when; every one
 * observes the same stream, pays one budget unit per question and learns through `absorb`.
 * Strategies never see the budget: they ask until the channel refuses (`canAsk`), so a run with
 * budget b asks exactly the first b questions of a run with a larger budget.
 */
export class Session {
  #knowledge: Knowledge = EMPTY_KNOWLEDGE;
  readonly #decisions: ActionId[] = [];

  constructor(
    readonly expert: SimulatedExpert,
    readonly stream: readonly StreamCase[],
    readonly thetaAsk: number,
  ) {}

  get knowledge(): Knowledge {
    return this.#knowledge;
  }

  /** The expert's decisions on the stream, in order. */
  get decisions(): readonly ActionId[] {
    return this.#decisions;
  }

  get canAsk(): boolean {
    return this.expert.remaining > 0;
  }

  /** The expert works stream case `i`; the learner records the decision. */
  decide(i: number): { caseId: string; features: Assignment; action: ActionId } {
    const c = this.stream[i];
    if (c === undefined) throw new RangeError(`no stream case ${i}`);
    const action = this.expert.decide(c.caseId, c.features);
    this.#decisions.push(action);
    this.#knowledge = observe(this.#knowledge, c.caseId, c.features, action);
    return { ...c, action };
  }

  ask(question: BenchQuestion, timing: QuestionTiming): ExpertAnswer {
    const answer = this.expert.ask(question, timing);
    this.#knowledge = absorb(this.#knowledge, question, answer);
    return answer;
  }
}

export type Strategy = (session: Session) => Promise<void>;
