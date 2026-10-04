import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CaseDesk } from "@/components/casedesk/case-desk";
import { currentViewer } from "@/lib/server/auth/viewer";

export const metadata: Metadata = { title: "CaseDesk · Northstar Bank (synthetic)" };
export const dynamic = "force-dynamic";

/** CaseDesk, the synthetic back-office sandbox the expert works in and the novice practises in (plan §8). */
export default async function CaseDeskPage() {
  const viewer = await currentViewer();
  if (viewer === undefined) redirect("/login?next=%2Fsandbox");
  return (
    <Suspense>
      <CaseDesk viewer={viewer} />
    </Suspense>
  );
}
