import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type TrackerStep = {
  label: string;
  state: "done" | "active" | "todo";
  /** A count shown beside the label (e.g. questions waiting). */
  badge?: number | undefined;
  /** Where the step happens when it is not on this screen. */
  href?: string | undefined;
};

/**
 * Where you are in the session, as numbered steps. Every state comes from the live session (cases
 * decided, questions queued), never from a script, so it is safe to trust at a glance.
 */
export function WorkflowTracker({ steps }: { steps: TrackerStep[] }) {
  return (
    <ol aria-label="Your progress" className="flex shrink-0 flex-wrap gap-5 border-b bg-white px-6 py-3">
      {steps.map((step, i) => {
        const body = (
          <>
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-medium",
                step.state === "done" && "bg-primary text-primary-foreground",
                step.state === "active" && "bg-primary text-primary-foreground",
                step.state === "todo" && "bg-muted text-muted-foreground",
              )}
            >
              {step.state === "done" ? <Check className="size-3.5" /> : i + 1}
            </span>
            {step.label}
            {step.badge !== undefined && step.badge > 0 && (
              <span className="rounded-full bg-highlight px-2 py-0.5 text-[11px] font-bold text-highlight-foreground">{step.badge}</span>
            )}
          </>
        );
        const cls = cn(
          "flex items-center gap-2 py-1 text-xs font-medium",
          step.state === "active" ? "text-foreground" : "text-muted-foreground",
          step.href !== undefined && "hover:bg-accent hover:text-accent-foreground",
        );
        return (
          <li key={step.label} aria-current={step.state === "active" ? "step" : undefined} className="contents">
            {step.href === undefined ? (
              <span className={cls}>{body}</span>
            ) : (
              <Link href={step.href} className={cls}>
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function expertSteps({ decided, total, queued, sessionId }: { decided: number; total: number; queued: number; sessionId: string }): TrackerStep[] {
  const reviewed = total > 0 && decided >= total;
  const debrief = `/debrief/${encodeURIComponent(sessionId)}`;
  return [
    { label: "Review cases", state: reviewed ? "done" : "active" },
    { label: "Answer questions", state: reviewed ? "done" : decided > 0 ? "active" : "todo", badge: queued },
    { label: "Confirm rules", state: reviewed ? "active" : "todo", href: debrief },
    { label: "Check coverage", state: "todo", href: debrief },
  ];
}

export function noviceSteps({ opened, decided }: { opened: boolean; decided: boolean }): TrackerStep[] {
  return [
    { label: "Open a case", state: opened ? "done" : "active" },
    { label: "Decide", state: decided ? "done" : opened ? "active" : "todo" },
    { label: "Saved", state: decided ? "active" : "todo" },
  ];
}
