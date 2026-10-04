import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { currentViewer } from "@/lib/server/auth/viewer";

export const metadata: Metadata = { title: "Create an account · CaseDesk" };
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if ((await currentViewer()) !== undefined) redirect("/home");
  return (
    <AuthCard
      title="Create an account"
      description="Every account starts as a trainee: practise with the tutor, take the held-out assessment. Only an admin grants the expert role."
      footer={
        <>
          Already have an account? <Link href="/login" className="font-medium text-foreground underline underline-offset-4">Sign in</Link>
        </>
      }
    >
      <SignUpForm />
    </AuthCard>
  );
}
