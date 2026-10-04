import { AlertTriangle, ArrowRight, CheckCircle2, GraduationCap } from "lucide-react";
import type { TutorState } from "@/lib/contracts/tutor";
import { cn } from "@/lib/utils";

export type GuideStage = "loading" | "no_rules" | "pick_case" | "working" | "all_done";

/** Where the trainee is, from the live session: what the coach can teach, whether a case is open, whether every case is decided. */
export function guideStage(input: { state: TutorState | undefined; hasSelected: boolean; decided: number; total: number }): GuideStage {
  if (input.state === undefined) return "loading";
  if (input.state.rules.length === 0) return "no_rules";
  if (input.total > 0 && input.decided >= input.total) return "all_done";
  return input.hasSelected ? "working" : "pick_case";
}

const STEPS = [
  { title: "Read the case", body: "Look at the country, who owns the company, the screening results and the source of funds." },
  { title: "Predict what the expert would decide", body: "Lock in your guess. Your coach then shows what the expert actually said, in their own words." },
  { title: "Make your decision and save", body: "If your choice would break an expert's rule, your coach warns you first and the Save button stops you." },
] as const;

/**
 * The trainee's guide: always says what to do next, in plain words. It never asks the trainee to find
 * a tool: the coach is on by default and its warnings appear here and on the case itself.
 */
export function TraineeGuide({ stage, rules, decided, total }: { stage: GuideStage; rules: number; decided: number; total: number }) {
  const notReady = stage === "no_rules";
  return (
    <section
      aria-label="Your coach"
      data-testid="trainee-guide"
      data-stage={stage}
      className={cn("grid gap-3 rounded-2xl p-4", notReady ? "bg-highlight-soft ring-1 ring-highlight/50" : "bg-primary text-primary-foreground")}
    >
      <h2 className="flex items-center gap-2 font-heading text-base font-bold">
        {notReady ? <AlertTriangle aria-hidden className="size-4" /> : stage === "all_done" ? <CheckCircle2 aria-hidden className="size-4" /> : <GraduationCap aria-hidden className="size-4" />}
        {stage === "loading" && "Your coach is getting ready"}
        {notReady && "Your coach has nothing to teach yet"}
        {stage === "pick_case" && "Start here: open a case"}
        {stage === "working" && "What to do now"}
        {stage === "all_done" && "You have decided every case"}
      </h2>

      {stage === "loading" && <p className="text-sm text-primary-foreground/85">One moment.</p>}

      {notReady && (
        <div className="grid gap-2 text-sm text-foreground/85">
          <p>
            The coach teaches from rules an <strong>expert has confirmed</strong>, and no expert has confirmed any yet. You can read the cases, but
            nothing will be checked when you save.
          </p>
          <p>Ask an expert to capture a session and confirm their rules, then come back. An admin can tell you whether that has happened.</p>
        </div>
      )}

      {stage === "pick_case" && (
        <p className="flex items-start gap-2 text-sm text-primary-foreground/90">
          <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-highlight" />
          Pick any case in the list on the left. Your coach is on and will guide you from there. {rules} expert rule{rules === 1 ? "" : "s"} to learn.
        </p>
      )}

      {stage === "working" && (
        <ol className="grid gap-2.5">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-highlight text-xs font-bold text-highlight-foreground">{i + 1}</span>
              <span className="grid text-sm">
                <strong>{step.title}</strong>
                <span className="text-primary-foreground/80">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {stage === "all_done" && (
        <p className="text-sm text-primary-foreground/90">
          {decided} of {total} cases decided. Check your mastery below.
        </p>
      )}
    </section>
  );
}
