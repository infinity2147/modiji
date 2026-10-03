"use client";

/**
 * Every explicit expert action needs the expert's own words: they are recorded as an
 * `expert.statement` (source expert) and become the rule's evidence (`human_text`).
 */
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function QuoteForm({
  submitLabel,
  placeholder,
  onSubmit,
  children,
  disabled = false,
}: {
  submitLabel: string;
  placeholder: string;
  onSubmit: (quote: string) => Promise<void>;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = quote.trim().length >= 3 && !busy && !disabled;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        onSubmit(quote.trim())
          .then(
            () => setQuote(""),
            () => undefined, // the page shows why; the words stay for another try
          )
          .finally(() => setBusy(false));
      }}
    >
      {children}
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        Your words (recorded as evidence)
      </label>
      <Textarea id={id} value={quote} onChange={(e) => setQuote(e.target.value)} placeholder={placeholder} rows={2} />
      <Button type="submit" size="sm" disabled={!ready}>
        {busy ? "Recording…" : submitLabel}
      </Button>
    </form>
  );
}
