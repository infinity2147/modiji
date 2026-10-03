import { PRODUCT_NAME, PRODUCT_THESIS } from "@/lib/product";

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{PRODUCT_NAME}</h1>
      <p className="text-lg text-neutral-600 sm:text-xl">{PRODUCT_THESIS}</p>
    </main>
  );
}
