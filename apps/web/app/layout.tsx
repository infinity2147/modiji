import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PRODUCT_NAME, PRODUCT_THESIS } from "@/lib/product";
import "./globals.css";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: PRODUCT_THESIS,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
