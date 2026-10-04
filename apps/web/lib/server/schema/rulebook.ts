/**
 * The confirmed rulebook as one feature model sees it. The rulebook is global (every expert session) but
 * concepts are confirmed per session (plan §6.6): a rule reading a concept is expressible only in a model
 * that has that concept. Consumers of a model — the debrief solver of a session, and the base-model
 * guardrails (Save interlock, tutor, MCP `check_action`) — get the rules expressible in it, so a rule over
 * a session concept can never make a solver or `checkAction` reject the whole rulebook elsewhere. Rules
 * confirmed under an older schema version stay in: they do not read the newer features.
 */
import "server-only";
import { ruleWithinModel, type DomainConfig, type Rulebook } from "@vashistha/core";

export function rulebookWithinModel(domain: DomainConfig, book: Rulebook): Rulebook {
  const rules = book.rules.filter((r) => ruleWithinModel(domain, r));
  return rules.length === book.rules.length ? book : { ...book, rules };
}

/** `rulebookWithinModel` over a cached rulebook source, returning the same object while the source does. */
export function rulebookViewWithinModel(domain: DomainConfig, source: () => Rulebook): () => Rulebook {
  let last: { book: Rulebook; view: Rulebook } | undefined;
  return () => {
    const book = source();
    if (last?.book !== book) last = { book, view: rulebookWithinModel(domain, book) };
    return last.view;
  };
}
