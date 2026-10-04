import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ClipboardCheck, Lock, Network } from "lucide-react";
import { StartCard } from "@/components/home/start-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Viewer } from "@/lib/contracts/auth";
import { currentViewer } from "@/lib/server/auth/viewer";
import { getRuntime } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Home · Vashistha" };
export const dynamic = "force-dynamic";

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

const LADDER = [
  ["Untested", "You have not tried this rule yet"],
  ["Right with help", "Correct after the coach spoke up"],
  ["Right on your own", "Correct without any help"],
  ["Right at an edge case", "Correct where the rule is closest to its limit"],
  ["Mastered", "Ready for real work"],
] as const;

/** A big teal card: the one thing to do next. */
function NextStep({ eyebrow, title, body, children }: { eyebrow: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <section aria-label="Next step" className="grid gap-4 rounded-3xl bg-primary p-8 text-primary-foreground">
      <span className="w-fit rounded-full bg-highlight px-3.5 py-1.5 text-xs font-bold tracking-wider text-highlight-foreground">{eyebrow}</span>
      <h2 className="font-heading text-3xl leading-tight font-bold tracking-tight">{title}</h2>
      <p className="max-w-lg text-base leading-relaxed text-primary-foreground/85">{body}</p>
      {children}
    </section>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="grid gap-2.5">
      {items.map((text, i) => (
        <li key={text} className="flex items-center gap-3.5 rounded-2xl bg-muted/70 px-4 py-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
          <span className="text-[15px] font-semibold">{text}</span>
        </li>
      ))}
    </ol>
  );
}

function TraineeHome({ viewer }: { viewer: Viewer }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-5">
        <NextStep
          eyebrow="NEXT STEP"
          title="Practise one case with your coach"
          body="Predict the outcome, make your decision, and get coached before you save. It takes about five minutes."
        >
          <StartCard mode="novice" caseSet="practice" label="Start practising" />
        </NextStep>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">How a practice case works</CardTitle>
          </CardHeader>
          <CardContent>
            <Steps items={["Predict what the expert would decide", "Make your own decision", "Save, with a safety check that blocks known mistakes"]} />
          </CardContent>
        </Card>
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
          <Card className="bg-highlight-soft ring-highlight/40">
            <CardHeader>
              <CardTitle className="text-lg">{viewer.expertRequested ? "Expert request pending" : "Review cases for a living?"}</CardTitle>
              <CardDescription className="text-foreground/75">
                {viewer.expertRequested
                  ? "An admin will review your request. Sign in again once it is granted."
                  : "Expert access is granted by an admin. Ask whoever runs your team."}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </div>
      <Card role="region" aria-label="Mastery levels" className="content-start">
        <CardHeader>
          <CardTitle className="text-lg">Your mastery levels</CardTitle>
          <CardDescription>Each rule you practise climbs this ladder. The coach shows your level as you go.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-3">
            {LADDER.map(([name, text], i) => (
              <li key={name} className="flex items-start gap-3">
                <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-bold text-muted-foreground">{i + 1}</span>
                <span className="grid text-sm">
                  <strong>{name}</strong>
                  <span className="text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
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
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">How capture works</CardTitle>
          </CardHeader>
          <CardContent>
            <Steps items={["Review cases and answer a few short questions", "Open the debrief and confirm each proposed rule", "Check coverage, then confirm the teach-back"]} />
          </CardContent>
        </Card>
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
                <li key={s.id} className="grid gap-2 rounded-2xl bg-muted/70 px-4 py-3">
                  <span className="text-sm font-semibold">{s.at > 0 ? WHEN.format(s.at) : s.id.slice(0, 8)}</span>
                  <span className="flex flex-wrap gap-2">
                    <Link href={`/debrief/${encodeURIComponent(s.id)}`} className="inline-flex items-center gap-1 rounded-full bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground">
                      Debrief <ArrowRight className="size-3" aria-hidden />
                    </Link>
                    <Link href={`/workmap/${encodeURIComponent(s.id)}`} className="inline-flex items-center gap-1 rounded-full bg-secondary px-3.5 py-1.5 text-xs font-bold text-secondary-foreground">
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
        <Link href="/admin" className="inline-flex h-12 w-fit items-center gap-2 rounded-full bg-highlight px-7 text-base font-semibold text-highlight-foreground">
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
        <p className="text-base text-muted-foreground">Here is your next step. Everything else can wait.</p>
      </header>
      {viewer.role === "trainee" && <TraineeHome viewer={viewer} />}
      {viewer.role === "expert" && <ExpertHome viewer={viewer} />}
      {viewer.role === "admin" && <AdminHome />}
    </main>
  );
}
