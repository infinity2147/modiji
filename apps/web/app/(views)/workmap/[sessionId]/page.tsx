import type { Metadata } from "next";
import { WorkMapView } from "@/components/workmap/workmap-view";

export const metadata: Metadata = { title: "Work Map" };

/** The Work Map (plan §7.6): built by code from the ledger and the confirmed rulebook. */
export default async function WorkMapPage({ params }: PageProps<"/workmap/[sessionId]">) {
  const { sessionId } = await params;
  return <WorkMapView sessionId={sessionId} />;
}
