import type { Metadata } from "next";
import { ReplayPlayer } from "@/components/replay/replay-player";

export const metadata: Metadata = { title: "Verified replay · recorded run" };

/** Verified replay mode (plan §10): a genuine recorded run, re-verified on load, replayed through the live UI. */
export default async function ReplayPage({ params }: PageProps<"/replay/[bundleId]">) {
  const { bundleId } = await params;
  return <ReplayPlayer bundleId={bundleId} />;
}
