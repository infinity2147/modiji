"use client";

/**
 * Two experts (plan §7.10, P10): both experts' confirmed rulebooks side by side, the valid case where Z3
 * finds they decide differently (in domain labels), each expert's decision and exact words, the
 * resolution diff and the team rule the interlock, tutor and MCP enforce. Everything is computed by the
 * server from the ledger; this page only records each expert's own answer.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Languages, Scale, ShieldAlert, Users } from "lucide-react";
import { EXPERT_LANGUAGE_LABELS, MACHINE_TRANSLATION_LABEL } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { describeError } from "@/lib/client/api";
import type { DisagreementAnswer, DisagreementView, DisagreementsState, ExpertView, PairState, RuleCard } from "@/lib/contracts/disagreements";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuoteForm } from "@/components/debrief/quote-form";
import { answerDisagreement, getDisagreements, searchDisagreements, type PairQuery } from "./api";

const POLL_MS = 4_000;

const STATUS: Record<DisagreementView["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  asked: { label: "asked both experts", variant: "default" },
  answered_one: { label: "one answer in", variant: "default" },
  still_disagree: { label: "still disagree · held back", variant: "destructive" },
  agreed: { label: "agreed · solver still finds the case", variant: "outline" },
  resolved: { label: "resolved", variant: "secondary" },
};

const selectClass = "h-9 rounded-md border bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function expertLabel(e: ExpertView): string {
  return e.named ? `${e.name} (${e.id})` : `Unnamed expert · session ${e.sessionIds[0]?.slice(0, 8) ?? ""}`;
}

/** The expert's original words; a translation is shown under a machine-translation label, never instead of them. */
function Quote({ text, language, translation }: { text: string; language?: string | undefined; translation?: string | undefined }) {
  return (
    <figure className="space-y-1">
      <blockquote lang={language} className="border-l-2 pl-2 text-sm italic">
        “{text}”
      </blockquote>
      {language !== undefined && language !== "en" && (
        <figcaption className="space-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Languages className="size-3" aria-hidden /> spoken in {EXPERT_LANGUAGE_LABELS[language === "hi" ? "hi" : "en"]}
          </span>
          {translation === undefined ? (
            <span>No English translation on record (translation pending).</span>
          ) : (
            <span>
              <Badge variant="outline" className="mr-1">translated</Badge>
              {MACHINE_TRANSLATION_LABEL}: “{translation}”
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function RuleItem({ card, names, showAuthor = false }: { card: RuleCard; names: Map<string, string>; showAuthor?: boolean }) {
  const quote = card.rule.evidence.find((e) => e.kind === "expert_quote" && e.relation === "supports");
  const guardrail = card.rule.effect.type === "forbid" || card.rule.effect.type === "require_approval";
  return (
    <li className="space-y-1.5 rounded-md border p-2" data-testid="expert-rule" data-held={card.held}>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Badge variant={guardrail ? "destructive" : "outline"}>{guardrail ? "guardrail" : card.rule.kind}</Badge>
        {card.held && <Badge variant="destructive">held back</Badge>}
        {showAuthor && <Badge variant="outline">{names.get(card.rule.expertId) ?? card.rule.expertId}</Badge>}
        {card.sharedWith.length > 0 && <Badge variant="secondary">also confirmed by {card.sharedWith.map((e) => names.get(e) ?? e).join(", ")}</Badge>}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {card.rule.id} · r{card.rule.revision} · p{card.rule.priority}
        </span>
      </div>
      <p className="text-sm">
        When <span className="font-medium">{card.when}</span> → <strong>{card.then}</strong>
      </p>
      {card.rule.overrides.length > 0 && <p className="text-xs text-muted-foreground">overrides {card.rule.overrides.join(", ")}</p>}
      {quote?.kind === "expert_quote" && <Quote text={quote.exactQuote} language={quote.language} translation={quote.translation} />}
    </li>
  );
}

function Rulebook({ title, cards, names, empty }: { title: string; cards: RuleCard[]; names: Map<string, string>; empty: string }) {
  return (
    <Card aria-label={title}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {cards.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="space-y-2">{cards.map((c) => <RuleItem key={c.rule.id} card={c} names={names} />)}</ul>}
      </CardContent>
    </Card>
  );
}

function AnswerBlock({
  expert,
  answer,
  decision,
  view,
  familyActions,
  submit,
}: {
  expert: ExpertView;
  answer: DisagreementAnswer | null;
  decision: DisagreementView["decisions"][number];
  view: DisagreementView;
  familyActions: { id: string; label: string }[];
  submit: (decision: string, quote: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<string>(familyActions[0]?.id ?? "");
  const question = view.questions.find((q) => q.expertId === expert.id);
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="expert-answer">
      <p className="text-sm font-medium">{expert.name}</p>
      <p className="text-sm">
        Their rulebook decides: <strong>{decision.label}</strong>
      </p>
      {question !== undefined && (
        <div className="text-xs text-muted-foreground">
          <p>
            Question for {expert.name} ({question.status}): <span lang={expert.language}>“{question.text}”</span>
          </p>
          {question.textEnglish !== null && <p>English original: “{question.textEnglish}”</p>}
        </div>
      )}
      {answer !== null ? (
        <div className="space-y-1">
          <p className="text-sm">
            Answered <strong>{answer.actionLabel}</strong> <Badge variant="outline">{answer.via}</Badge>
          </p>
          <Quote text={answer.quote.text} language={answer.quote.language} translation={answer.quote.translation} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No answer yet.</p>
      )}
      {view.status !== "resolved" && (
        <QuoteForm submitLabel={`Record ${expert.name}'s decision`} placeholder="In your own words: what would you decide here, and why?" onSubmit={(quote) => submit(choice, quote)}>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            {expert.name}&apos;s decision
            <select className={selectClass} value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={`${expert.name}'s decision`}>
              {familyActions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </QuoteForm>
      )}
    </div>
  );
}

function DisagreementCard({ pair, view, submit }: { pair: PairState; view: DisagreementView; submit: (expertId: string, decision: string, quote: string) => Promise<void> }) {
  const status = STATUS[view.status];
  const familyActions = (KYC_DOMAIN.decisionFamilies.find((f) => f.id === pair.decisionFamily)?.actions ?? []).map((id) => ({ id, label: KYC_DOMAIN.actions.find((a) => a.id === id)?.label ?? id }));
  const r = view.resolution;
  return (
    <Card aria-label="Disagreement case" data-testid="disagreement" data-status={view.status}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Scale className="size-4" aria-hidden /> A valid case where they decide differently
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">{view.witness.id}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Found by Z3 over both confirmed rulebooks, within the domain constraints. When found: {pair.experts[0].name} → {view.foundActions[0]}, {pair.experts[1].name} → {view.foundActions[1]}.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <table className="w-full text-sm" aria-label="The case">
          <tbody>
            {view.caseLines.map((l) => (
              <tr key={l.feature} className="border-b last:border-0">
                <th className="py-1 pr-3 text-left font-normal text-muted-foreground">{l.label}</th>
                <td className="py-1 font-medium">{l.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid gap-3 md:grid-cols-2">
          {([0, 1] as const).map((i) => (
            <AnswerBlock
              key={pair.experts[i].id}
              expert={pair.experts[i]}
              answer={view.answers[i]}
              decision={view.decisions[i]}
              view={view}
              familyActions={familyActions}
              submit={(decision, quote) => submit(pair.experts[i].id, decision, quote)}
            />
          ))}
        </div>
        {r !== null && (
          <div className="space-y-2 rounded-md border border-emerald-600/40 bg-emerald-50/40 p-3 dark:bg-emerald-950/20" data-testid="resolution">
            <p className="text-sm font-medium">
              Resolution: {r.kind === "rule_revised" ? `rule ${r.ruleId} revised to r${r.revision}` : `new rule ${r.ruleId}`}, confirmed by both experts with both quotes
            </p>
            <div className="grid gap-2 text-sm md:grid-cols-[1fr_auto_1fr] md:items-center">
              <div className="rounded border bg-background p-2">
                <p className="text-xs text-muted-foreground">before</p>
                {r.before === null ? (
                  <p className="text-muted-foreground">no rule</p>
                ) : (
                  <p>
                    When {r.before.when} → <strong>{r.before.then}</strong>
                    <span className="block text-xs text-muted-foreground">experts {r.before.experts.join(", ")} · overrides {r.before.overrides.join(", ") || "none"}</span>
                  </p>
                )}
              </div>
              <ArrowRight className="mx-auto size-4" aria-hidden />
              <div className="rounded border bg-background p-2">
                <p className="text-xs text-muted-foreground">after</p>
                <p>
                  When {r.after.when} → <strong>{r.after.then}</strong>
                  <span className="block text-xs text-muted-foreground">experts {r.after.experts.join(", ")} · overrides {r.after.overrides.join(", ") || "none"}</span>
                </p>
              </div>
            </div>
            {r.fields.length > 0 && <p className="text-xs text-muted-foreground">changed: {r.fields.join(", ")}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TwoExpertsView({ initialA, initialB, initialFamily }: { initialA?: string | undefined; initialB?: string | undefined; initialFamily: string }) {
  const [state, setState] = useState<DisagreementsState | null>(null);
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const [family, setFamily] = useState(initialFamily);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pair: PairQuery | undefined = useMemo(() => (a !== undefined && b !== undefined && a !== b ? { experts: [a, b], decisionFamily: family } : undefined), [a, b, family]);

  const refresh = useCallback(
    () =>
      getDisagreements(fetch, pair).then(
        (next) => {
          setState(next);
          // A spoken answer completes an agreement: one reconciliation step writes the resolution.
          if (pair !== undefined && next.pair?.witnesses.some((v) => v.status === "agreed" && v.resolution === null))
            void searchDisagreements(fetch, pair).then((r) => setState(r.state), () => undefined);
        },
        (e: unknown) => setError(describeError(e)),
      ),
    [pair],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Two experts by default once the directory is known.
  useEffect(() => {
    if (state === null) return;
    const first = a ?? state.experts[0]?.id;
    if (a === undefined && first !== undefined) setA(first);
    if (b === undefined) setB(state.experts.find((e) => e.id !== first)?.id);
  }, [state, a, b]);

  const run = useCallback(async (label: string, task: () => Promise<DisagreementsState>): Promise<boolean> => {
    setBusy(label);
    try {
      setState(await task());
      setError(null);
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const search = () => pair !== undefined && void run("Searching both rulebooks with Z3…", async () => (await searchDisagreements(fetch, pair)).state);
  const submit = async (expertId: string, witnessId: string, decision: string, quote: string): Promise<void> => {
    if (pair === undefined) return;
    if (!(await run("Recording the expert's decision…", async () => (await answerDisagreement(fetch, pair, { witnessId, expertId, decision, quote })).state))) throw new Error("refused");
  };

  const experts = state?.experts ?? [];
  const names = new Map(experts.map((e) => [e.id, e.name]));
  const p = state?.pair ?? null;

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Users className="size-6" aria-hidden /> Two experts
          </h1>
          <p className="text-sm text-muted-foreground">Where two experts&apos; confirmed rules decide the same valid case differently — and how they settled it.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          {([
            ["First expert", a, setA],
            ["Second expert", b, setB],
          ] as const).map(([label, value, set]) => (
            <label key={label} className="grid gap-1 text-xs font-medium text-muted-foreground">
              {label}
              <select className={selectClass} value={value ?? ""} onChange={(e) => set(e.target.value === "" ? undefined : e.target.value)} aria-label={label}>
                <option value="">—</option>
                {experts.map((e) => (
                  <option key={e.id} value={e.id}>
                    {expertLabel(e)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Decision
            <select className={selectClass} value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Decision family">
              {(state?.families ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={search} disabled={pair === undefined || busy !== null}>
            Find disagreements (Z3)
          </Button>
        </div>
      </header>
      {busy !== null && <p className="text-sm text-muted-foreground">{busy}</p>}
      {error !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
          {error}
        </p>
      )}
      {state === null ? (
        <p className="text-muted-foreground">Loading the experts…</p>
      ) : experts.length < 2 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Two experts are needed. Start an expert session in <Link className="underline" href="/sandbox">CaseDesk</Link> with each expert&apos;s name, capture their decisions and confirm their rules in the debrief. {experts.length === 1 ? `So far only ${experts[0]?.name ?? "one expert"} has a session.` : "No expert session yet."}
          </CardContent>
        </Card>
      ) : p === null ? (
        <p className="text-sm text-muted-foreground">Choose two different experts.</p>
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-2" aria-label="Both rulebooks">
            {([0, 1] as const).map((i) => (
              <Rulebook
                key={p.experts[i].id}
                title={`${p.experts[i].name}'s rulebook · ${p.familyLabel}`}
                cards={p.rulebooks[i]}
                names={names}
                empty={`${p.experts[i].name} has no confirmed rule for this decision yet.`}
              />
            ))}
          </section>
          <section className="space-y-3" aria-label="Disagreements">
            {p.witnesses.length === 0 ? (
              <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                  No disagreement recorded yet. “Find disagreements” asks Z3 for a valid case where the two rulebooks decide differently; when it finds none, none exists under the current feature model.
                </CardContent>
              </Card>
            ) : (
              p.witnesses.map((v) => <DisagreementCard key={v.witness.id} pair={p} view={v} submit={(expertId, decision, quote) => submit(expertId, v.witness.id, decision, quote)} />)
            )}
          </section>
          <section aria-label="Team rulebook">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="size-4" aria-hidden /> Team rulebook in force · {p.familyLabel} · {p.open} open disagreement{p.open === 1 ? "" : "s"}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  What the Save interlock, the tutor and MCP check_action enforce: every expert&apos;s confirmed rules, except decision rules held back (marked) while their experts disagree on a case. Guardrails are never held back, so a disagreement can only make the interlock stricter.
                </p>
              </CardHeader>
              <CardContent>
                {p.team.length === 0 ? <p className="text-sm text-muted-foreground">No rule in force for this decision.</p> : <ul className="space-y-2">{p.team.map((c) => <RuleItem key={c.rule.id} card={c} names={names} showAuthor />)}</ul>}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </main>
  );
}
