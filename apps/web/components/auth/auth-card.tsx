import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/shell/sidebar-nav";

/** The frame of the sign-in and sign-up pages: a teal promise panel beside the form. */
export function AuthCard({ title, description, children, footer }: { title: string; description: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex flex-col justify-between gap-10 bg-primary p-8 text-primary-foreground md:w-[42%] md:p-14">
        <Link href="/" className="text-primary-foreground" aria-label="Sage home">
          <Logo />
        </Link>
        <div className="grid gap-6">
          <p className="font-heading text-4xl leading-[1.08] font-bold tracking-tight md:text-5xl">Every rule traces back to a real expert.</p>
          <ul className="grid gap-3.5 text-lg text-primary-foreground/85">
            {["New accounts start as trainees", "An admin approves experts", "You only see what your role needs"].map((line) => (
              <li key={line} className="flex gap-3">
                <span aria-hidden className="mt-2.5 size-2.5 shrink-0 rounded-full bg-highlight" />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-primary-foreground/70">Sample data only. Every customer, company and country is fictional.</p>
      </aside>
      <main className="grid flex-1 place-items-center px-6 py-12">
        <div className="grid w-full max-w-md gap-7">
          <header className="grid gap-2">
            <h1 className="font-heading text-4xl font-bold tracking-tight">{title}</h1>
            <p className="text-base text-muted-foreground">{description}</p>
          </header>
          {children}
          <p className="text-center text-sm text-muted-foreground">{footer}</p>
        </div>
      </main>
    </div>
  );
}

export const inputClass =
  "h-12 w-full rounded-2xl border border-input bg-card px-4 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";
