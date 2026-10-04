import type { Metadata } from "next";
import { ReplayList } from "@/components/replay/replay-list";

export const metadata: Metadata = { title: "Verified replay · recorded runs" };

export default function ReplayIndexPage() {
  return <ReplayList />;
}
