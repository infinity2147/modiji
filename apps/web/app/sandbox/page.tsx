import { Suspense } from "react";
import type { Metadata } from "next";
import { CaseDesk } from "@/components/casedesk/case-desk";

export const metadata: Metadata = { title: "CaseDesk · Northstar Bank (synthetic)" };

/** CaseDesk, the synthetic back-office sandbox the expert works in and the novice practises in (plan §8). */
export default function CaseDeskPage() {
  return (
    <Suspense>
      <CaseDesk />
    </Suspense>
  );
}
