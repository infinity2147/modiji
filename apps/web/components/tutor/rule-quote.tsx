"use client";

import { useState } from "react";
import { Ban, Film, ImageOff, Quote, VolumeX } from "lucide-react";
import type { TutorRule } from "@/lib/contracts/tutor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** The expert's moment behind a rule (`replay_moment`): their redacted screen, their exact words, and what is unavailable and why. */
export function ReplayDialog({ rule, open, onOpenChange }: { rule: TutorRule | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open && rule !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {rule && (
          <>
            <DialogHeader>
              <DialogTitle>The expert&rsquo;s moment</DialogTitle>
              <DialogDescription>
                {rule.then} when {rule.when}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              {rule.quote.replay.frameUrl ? (
                <img
                  src={rule.quote.replay.frameUrl}
                  alt="Redacted frame of the expert's screen when they said this"
                  className="w-full rounded-md border"
                />
              ) : (
                <div role="note" className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 p-4 text-[13px] text-muted-foreground">
                  <ImageOff aria-hidden className="size-4 shrink-0" />
                  {rule.quote.replay.frameNote}
                </div>
              )}
              {rule.quote.replay.screen.length > 0 && (
                <section aria-label="Expert's screen (DOM channel)" className="grid gap-1">
                  <h3 className="text-xs font-medium text-muted-foreground">On the expert&rsquo;s screen (DOM channel)</h3>
                  <ul className="grid gap-0.5 text-[13px]">
                    {rule.quote.replay.screen.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </section>
              )}
              <ExpertWords rule={rule} />
              <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <VolumeX aria-hidden className="size-3.5 shrink-0" />
                <span>
                  <Button size="xs" variant="outline" disabled className="mr-2">
                    Play audio
                  </Button>
                  {rule.quote.replay.audioNote}
                </span>
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ExpertWords({ rule }: { rule: TutorRule }) {
  return (
    <figure className="grid gap-1 rounded-md border bg-muted/40 p-3">
      <blockquote className="flex gap-2 text-[13px] leading-relaxed">
        <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="font-medium text-foreground" data-testid="expert-quote">
          “{rule.quote.text}”
        </p>
      </blockquote>
      <figcaption className="pl-5.5 text-[11px] text-muted-foreground">{rule.quote.attribution}</figcaption>
    </figure>
  );
}

/** A confirmed rule in plain words with the expert's verbatim quote and a replay of their moment. */
export function RuleQuote({ rule }: { rule: TutorRule }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-2">
      <p className="flex gap-1.5 text-[13px] leading-snug">
        {rule.stopRule && <Ban aria-label="Stop-rule" className="mt-0.5 size-3.5 shrink-0 text-red-600" />}
        <span>
          <span className="text-muted-foreground">When</span> {rule.when}: <span className="font-medium">{rule.then}</span>
        </span>
      </p>
      <ExpertWords rule={rule} />
      <div>
        <Button type="button" size="xs" variant="outline" onClick={() => setOpen(true)}>
          <Film data-icon="inline-start" />
          Replay the expert&rsquo;s moment
        </Button>
      </div>
      <ReplayDialog rule={rule} open={open} onOpenChange={setOpen} />
    </div>
  );
}
