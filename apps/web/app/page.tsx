import Link from "next/link";
import { PRODUCT_NAME, PRODUCT_THESIS } from "@/lib/product";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{PRODUCT_NAME}</h1>
      <p className="text-lg text-neutral-600 sm:text-xl">{PRODUCT_THESIS}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/signup">Create an account</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/replay">Watch a recorded run</Link>
        </Button>
      </div>
    </main>
  );
}
