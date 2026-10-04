import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountsView } from "@/components/admin/accounts-view";
import { currentViewer } from "@/lib/server/auth/viewer";

export const metadata: Metadata = { title: "Accounts · CaseDesk" };
export const dynamic = "force-dynamic";

/** Admin only (the API refuses everyone else too). */
export default async function AdminPage() {
  const viewer = await currentViewer();
  if (viewer === undefined) redirect("/login?next=%2Fadmin");
  if (viewer.role !== "admin")
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="grid gap-2">
          <h1 className="text-xl font-semibold">Admins only</h1>
          <p className="text-sm text-muted-foreground">Accounts are managed by an admin. You are signed in as {viewer.displayName}.</p>
          <Link href="/sandbox" className="text-sm underline underline-offset-4">Back to CaseDesk</Link>
        </div>
      </main>
    );
  return <AccountsView viewer={viewer} />;
}
