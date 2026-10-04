import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { currentViewer } from "@/lib/server/auth/viewer";

export const dynamic = "force-dynamic";

/** Every signed-in page outside CaseDesk shares one shell: the role-aware sidebar beside the page. */
export default async function ViewsLayout({ children }: { children: ReactNode }) {
  const viewer = await currentViewer();
  if (viewer === undefined) redirect("/login");
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <SidebarNav viewer={viewer} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
