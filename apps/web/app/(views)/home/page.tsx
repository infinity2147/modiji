import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ClipboardCheck, Lock, Network } from "lucide-react";
import { StartCard } from "@/components/home/start-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Viewer } from "@/lib/contracts/auth";
import { currentViewer } from "@/lib/server/auth/viewer";
import { getRuntime } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Home · Sage" };
export const dynamic = "force-dynamic";

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

const LADDER = [
  ["Untested", "You have not tried this rule yet"],
  ["Right with help", "Correct after the coach spoke up"],
  ["Right on your own", "Correct without any help"],
  ["Right at an edge case", "Correct where the rule is closest to its limit"],
  ["Mastered", "Ready for real work"],
] as const;

/** The primary task, with one clear action. */
function NextStep({ eyebrow, title, body, children }: { eyebrow: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section aria-label="Next step" className="grid gap-4 rounded-lg border bg-white p-6 text-foreground">
      <span className="text-xs font-medium text-muted-foreground">{eyebrow}</span>
      <h2 className="font-heading text-2xl leading-tight font-semibold tracking-tight">{title}</h2>
      <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">{body}</p>
      {children}
    </section>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="grid gap-2.5">
      {items.map((text, i) => (
        <li key={text} className="flex items-center gap-3.5 border-b py-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
          <span className="text-[15px] font-semibold">{text}</span>
        </li>
      ))}
    </ol>
  );
}

function TraineeHome({ viewer, rules }: { viewer: Viewer; rules: number }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-5">
        {rules === 0 ? (
          <section aria-label="Next step" data-testid="coach-not-ready" className="grid gap-4 rounded-lg border border-amber-200 bg-white p-6">
            <span className="text-xs font-medium text-muted-foreground">NOT READY YET</span>
            <h2 className="font-heading text-2xl leading-tight font-semibold tracking-tight">Your coach has nothing to teach yet</h2>
            <p className="max-w-lg text-base leading-relaxed text-foreground/80">
              The coach teaches from rules an expert has confirmed in their own words, and no expert has confirmed any yet. Until then there is
              nothing to learn and nothing to check when you save.
            </p>
            <ol className="grid gap-2 text-sm font-semibold">
              <li className="rounded-2xl bg-card/70 px-4 py-3">1. An expert signs in, captures a few cases and confirms their rules in the debrief.</li>
              <li className="rounded-2xl bg-card/70 px-4 py-3">2. This page then shows your coach as ready and tells you where to start.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/replay" className="inline-flex h-12 items-center gap-2 rounded-md bg-primary px-7 text-base font-semibold text-primary-foreground">
                Watch a recorded run <ArrowRight className="size-4" aria-hidden />
              </Link>
              <StartCard mode="novice" caseSet="practice" label="Look around anyway" tone="light" />
            </div>
          </section>
        ) : (
          <NextStep
            eyebrow="NEXT STEP"
            title="Practise one case with your coach"
            body={`Your coach has ${rules} expert rule${rules === 1 ? "" : "s"} to teach. Predict the outcome, make your decision, and get coached before you save. It takes about five minutes.`}
          >
            <StartCard mode="novice" caseSet="practice" label="Start practising" />
          </NextStep>
        )}
        <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">Practice workflow</summary>
        <Card className="mt-4 border-0 ring-0">
          <CardHeader>
            <CardTitle className="text-lg">How a practice case works</CardTitle>
          </CardHeader>
          <CardContent>
            <Steps items={["Predict what the expert would decide", "Make your own decision", "Save, with a safety check that blocks known mistakes"]} />
          </CardContent>
        </Card>
        </details>
        <div className="grid gap-5 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ClipboardCheck className="size-5 text-primary" aria-hidden />
                Held-out assessment
              </CardTitle>
              <CardDescription>Cases the expert never showed you. Best after a few practice cases.</CardDescription>
            </CardHeader>
            <CardContent>
              <StartCard mode="novice" caseSet="heldout" label="Take the assessment" tone="light" />
            </CardContent>
          </Card>
          {viewer.expertRequested && <p className="text-sm text-muted-foreground">Expert request pending. An admin will review your request.</p>}
        </div>
      </div>
      <details className="rounded-lg border bg-white p-5"><summary className="cursor-pointer text-sm font-medium">How progress is measured</summary>
      <Card role="region" aria-label="Mastery levels" className="mt-4 content-start border-0 ring-0">
        <CardHeader>
          <CardTitle className="text-lg">Your mastery levels</CardTitle>
          <CardDescription>Each rule you practise climbs this ladder. The coach shows your level as you go.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3">
            {LADDER.map(([name, text], i) => (
              <li key={name} className="flex items-start gap-3">
                <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-bold text-muted-foreground">{i + 1}</span>
                <span className="grid text-sm">
                  <strong>{name}</strong>
                  <span className="text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card></details>
    </div>
  );
}

function ExpertHome({ viewer }: { viewer: Viewer }) {
  const runtime = getRuntime();
  const record = runtime.experts.directory().find((e) => e.id === viewer.username);
  const sessions = [...(record?.sessionIds ?? [])]
    .reverse()
    .slice(0, 5)
    .map((id) => ({ id, at: runtime.ledger.getSession(id)?.createdAt ?? 0 }));
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-5">
        <NextStep
          eyebrow="NEXT STEP"
          title="Work a few cases while your assistant listens"
          body="Review cases as you normally would. The assistant speaks only when you pause, and nothing becomes a rule until you confirm it."
        >
          <StartCard mode="expert" caseSet="training" label="Start a capture session" askLanguage />
        </NextStep>
        <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">Capture workflow</summary>
        <Card className="mt-4 border-0 ring-0">
          <CardHeader>
            <CardTitle className="text-lg">How capture works</CardTitle>
          </CardHeader>
          <CardContent>
            <Steps items={["Review cases and answer a few short questions", "Open the debrief and confirm each proposed rule", "Check coverage, then confirm the teach-back"]} />
          </CardContent>
        </Card>
        </details>
      </div>
      <Card role="region" aria-label="Your sessions" className="content-start">
        <CardHeader>
          <CardTitle className="text-lg">Your sessions</CardTitle>
          <CardDescription>Open the debrief to confirm rules, or the Work Map to see how a decision was reached.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions yet. Your first one will appear here.</p>
          ) : (
            <ul className="grid gap-2.5">
              {sessions.map((s) => (
                <li key={s.id} className="grid gap-2 border-b py-3">
                  <span className="text-sm font-semibold">{s.at > 0 ? WHEN.format(s.at) : s.id.slice(0, 8)}</span>
                  <span className="flex flex-wrap gap-2">
                    <Link href={`/debrief/${encodeURIComponent(s.id)}`} className="inline-flex items-center gap-1 rounded-md bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground">
                      Debrief <ArrowRight className="size-3" aria-hidden />
                    </Link>
                    <Link href={`/workmap/${encodeURIComponent(s.id)}`} className="inline-flex items-center gap-1 rounded-md bg-secondary px-3.5 py-1.5 text-xs font-bold text-secondary-foreground">
                      <Network className="size-3" aria-hidden /> Work Map
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AdminHome() {
  const pending = getRuntime().accounts.list().filter((a) => a.expertRequested && a.role === "trainee" && a.disabledAt === null).length;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <NextStep
        eyebrow={pending > 0 ? "WAITING FOR YOU" : "ALL CAUGHT UP"}
        title={pending > 0 ? `${pending} expert request${pending === 1 ? "" : "s"} to review` : "No expert requests waiting"}
        body="An expert's confirmed words become rules that every trainee and agent is checked against. Grant the role only to people who do this work."
      >
        <Link href="/admin" className="inline-flex h-12 w-fit items-center gap-2 rounded-md bg-highlight px-7 text-base font-semibold text-highlight-foreground">
          Open accounts <ArrowRight className="size-4" aria-hidden />
        </Link>
      </NextStep>
      <Card className="content-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lock className="size-5 text-primary" aria-hidden />
            What admins can and cannot do
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>Approve or decline experts, change roles, disable accounts, and read any session.</p>
          <p>Admins never confirm a rule in an expert's name. Every role change is logged and cannot be edited.</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default async function HomePage() {
  const viewer = await currentViewer();
  if (viewer === undefined) return null;
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 md:px-9">
      <header className="grid gap-1">
        <h1 className="font-heading text-3xl font-bold tracking-tight">Welcome, {viewer.displayName}</h1>
        <p className="text-base text-muted-foreground">Choose where to continue.</p>
      </header>
      {viewer.role === "trainee" && <TraineeHome viewer={viewer} rules={getRuntime().rulebook().length} />}
      {viewer.role === "expert" && <ExpertHome viewer={viewer} />}
      {viewer.role === "admin" && <AdminHome />}
    </main>
  );
}
