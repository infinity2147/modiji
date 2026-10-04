import type { Metadata } from "next";
import { TwoExpertsView } from "@/components/experts/two-experts-view";

export const metadata: Metadata = { title: "Two experts · disagreement and reconciliation" };

/** Two experts (plan §7.10): both rulebooks, the Z3 case where they disagree, each expert's answer, the reconciled team rule. */
export default async function ExpertsPage({ searchParams }: PageProps<"/experts">) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  return <TwoExpertsView initialA={one(params.a)} initialB={one(params.b)} initialFamily={one(params.family) ?? "reviewOutcome"} />;
}
