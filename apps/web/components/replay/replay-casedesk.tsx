"use client";

import type { KycCase } from "@vashistha/core/domains/kyc";
import { FolderOpen } from "lucide-react";
import type { ReplayCaseDesk } from "@/lib/client/replay/casedesk";
import type { Tutor } from "@/lib/client/tutor/use-tutor";
import type { TutorState } from "@/lib/contracts/tutor";
import { CaseDetail } from "@/components/casedesk/case-detail";
import { CaseQueue } from "@/components/casedesk/case-queue";
import { ReviewPanel } from "@/components/casedesk/review-panel";
import { NoviceReview } from "@/components/tutor/novice-review";
import { TutorPanels } from "@/components/tutor/tutor-panels";

const noop = (): void => undefined;
const readOnly = (): Promise<never> => Promise.reject(new Error("Verified replay is read-only."));

/** The tutor as the novice UI consumes it, fed by the replay's derived tutor view; every action is refused. */
function replayTutor(state: TutorState | null): Tutor {
  return { state: state ?? undefined, error: undefined, refresh: noop, intent: noop, predict: readOnly, practice: readOnly, judgeCase: readOnly, briefing: readOnly, chat: readOnly, nudge: readOnly };
}

/**
 * CaseDesk of a recorded session, through the live components (queue, case file, review panel, the
 * tutor's predict/reveal/intervention cards and mastery ladder), inside a disabled fieldset: nothing on
 * this screen can act.
 */
export function ReplayCaseDeskView({ desk, mode, tutorState }: { desk: ReplayCaseDesk; mode: "expert" | "novice"; tutorState: TutorState | null }) {
  const selected: KycCase | undefined = desk.cases.find((c) => c.id === desk.selectedId);
  const tutor = replayTutor(tutorState);
  const novice = mode === "novice";
  const draft = selected === undefined ? undefined : desk.drafts.get(selected.id);
  return (
    <fieldset disabled aria-label="Recorded CaseDesk (read-only)" className="grid min-h-0 min-w-0 flex-1 grid-cols-[18rem_minmax(0,1fr)_20rem]">
      <div className="flex min-h-0 flex-col">
        <CaseQueue cases={desk.cases} decisions={desk.session.decisions} selectedId={desk.selectedId} lastCommitted={desk.lastCommitted} onOpen={noop} />
      </div>
      <main className="min-h-0 overflow-y-auto p-4">
        {selected ? (
          <CaseDetail kycCase={selected} />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            <p className="flex items-center gap-2">
              <FolderOpen aria-hidden className="size-5" /> No case open at this point of the recording.
            </p>
          </div>
        )}
      </main>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto border-l bg-muted/30 p-3 *:shrink-0">
        {selected && draft && (
          <ReviewSlot novice={novice} tutor={tutor} kycCase={selected} outcome={draft.outcome} riskRating={draft.riskRating}>
            <ReviewPanel
              kycCase={selected}
              draft={draft}
              decision={desk.session.decisions.get(selected.id)}
              fresh={desk.lastCommitted === selected.id}
              saveState={{ status: "idle" }}
              locked
              onRiskRating={noop}
              onOutcome={noop}
              onSave={noop}
            />
          </ReviewSlot>
        )}
        {novice && <TutorPanels tutor={tutor} onCases={noop} />}
      </div>
    </fieldset>
  );
}

function ReviewSlot({
  novice,
  tutor,
  kycCase,
  outcome,
  riskRating,
  children,
}: {
  novice: boolean;
  tutor: Tutor;
  kycCase: KycCase;
  outcome: Parameters<typeof NoviceReview>[0]["outcome"];
  riskRating: Parameters<typeof NoviceReview>[0]["riskRating"];
  children: React.ReactNode;
}) {
  if (!novice) return children;
  return (
    <NoviceReview key={kycCase.id} tutor={tutor} kycCase={kycCase} outcome={outcome} riskRating={riskRating} locked>
      {children}
    </NoviceReview>
  );
}
