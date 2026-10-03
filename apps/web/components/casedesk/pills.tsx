import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-slate-100 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
  info: { pill: "bg-sky-50 text-sky-800 ring-sky-200", dot: "bg-sky-500" },
  success: { pill: "bg-emerald-50 text-emerald-800 ring-emerald-200", dot: "bg-emerald-500" },
  warning: { pill: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  danger: { pill: "bg-red-50 text-red-800 ring-red-200", dot: "bg-red-500" },
};

/** A compact status pill with a leading tone dot. */
export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] leading-none font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone].pill,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONES[tone].dot)} />
      {children}
    </span>
  );
}

const RISK_TONE = { low: "success", medium: "warning", high: "danger" } as const satisfies Record<string, Tone>;
const RISK_TEXT = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;

/** Northstar country-risk tier. */
export function RiskPill({ tier, className }: { tier: keyof typeof RISK_TONE; className?: string | undefined }) {
  return (
    <Pill tone={RISK_TONE[tier]} className={className}>
      {RISK_TEXT[tier]}
    </Pill>
  );
}

/** Yes/No for screening-style flags, coloured only when the answer is a concern. */
export function FlagPill({ value, concernWhen }: { value: boolean; concernWhen: boolean }) {
  return <Pill tone={value === concernWhen ? "danger" : "neutral"}>{value ? "Yes" : "No"}</Pill>;
}
