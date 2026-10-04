import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNext } from "@/lib/client/auth";
import { currentViewer } from "@/lib/server/auth/viewer";

export const metadata: Metadata = { title: "Sign in · CaseDesk" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const target = typeof next === "string" ? next : undefined;
  if ((await currentViewer()) !== undefined) redirect(safeNext(target));
  return (
    <AuthCard
      title="Sign in"
      description="Every session is owned by the account that started it, so every rule traces back to a real, signed-in expert."
      footer={
        <>
          New here? <Link href="/signup" className="font-medium text-foreground underline underline-offset-4">Create an account</Link> · or watch a{" "}
          <Link href="/replay" className="font-medium text-foreground underline underline-offset-4">recorded run</Link>
        </>
      }
    >
      <SignInForm next={target} />
    </AuthCard>
  );
}
