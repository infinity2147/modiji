import type { Metadata } from "next";
import { DebriefView } from "@/components/debrief/debrief-view";

export const metadata: Metadata = { title: "Debrief · counterexample closure" };

/** The expert's debrief (plan §7.5): witnesses, teach-back, rulebook diff, coverage under the current model. */
export default async function DebriefPage({ params }: PageProps<"/debrief/[sessionId]">) {
  const { sessionId } = await params;
  return <DebriefView sessionId={sessionId} />;
}
