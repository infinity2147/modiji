"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Loader2, MicOff, RotateCw, ShieldOff, Play } from "lucide-react";
import { OFF_RECORD_CLAIM, type PrivacyController, type PrivacyState } from "@/lib/client/voice/privacy";
import { usePrivacyController } from "@/lib/client/voice/use-interview";
import { Button } from "@/components/ui/button";

/** Alt+Shift+O toggles the record (by physical key, so macOS Option-letter composition does not matter). */
export const OFF_RECORD_SHORTCUT = "Alt+Shift+O";

function isShortcut(event: KeyboardEvent): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyO";
}

function toggle(controller: PrivacyController): void {
  const state = controller.state();
  if (state.offRecord && state.error === undefined) void controller.resume();
  else void controller.goOffRecord();
}

/** The always-visible off-record switch (plan §7.8), with its keyboard shortcut. */
export function OffRecordControl({ state }: { state: PrivacyState | null }) {
  const controller = usePrivacyController();

  useEffect(() => {
    if (!controller) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isShortcut(event) || event.repeat) return;
      event.preventDefault();
      toggle(controller);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  if (!controller || !state) {
    return (
      <Button variant="outline" disabled className="w-full">
        <Loader2 data-icon="inline-start" className="animate-spin" />
        Loading privacy state…
      </Button>
    );
  }
  if (state.offRecord) {
    return (
      <Button
        className="w-full bg-emerald-700 text-white hover:bg-emerald-800"
        disabled={state.pending}
        onClick={() => void controller.resume()}
        aria-keyshortcuts={OFF_RECORD_SHORTCUT}
      >
        {state.pending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
        {state.pending ? "Updating the record…" : "Resume the record"}
        <kbd className="ml-auto rounded border border-white/30 px-1 font-mono text-[10px]">{OFF_RECORD_SHORTCUT}</kbd>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      className="w-full border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
      disabled={state.pending}
      onClick={() => void controller.goOffRecord()}
      aria-keyshortcuts={OFF_RECORD_SHORTCUT}
    >
      <ShieldOff data-icon="inline-start" />
      Go off the record
      <kbd className="ml-auto rounded border border-red-200 px-1 font-mono text-[10px] text-red-600">{OFF_RECORD_SHORTCUT}</kbd>
    </Button>
  );
}

/** Full-width red banner while off the record, with the product's exact privacy claim. */
export function OffRecordBanner({ state }: { state: PrivacyState | null }) {
  const controller = usePrivacyController();
  if (!state?.offRecord || !controller) return null;
  return (
    <motion.div
      role="alert"
      aria-label="Off the record"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex shrink-0 items-start gap-3 border-b border-red-800 bg-red-700 px-4 py-2.5 text-white"
    >
      <MicOff aria-hidden className="mt-0.5 size-5 shrink-0" />
      <div className="grid min-w-0 gap-0.5">
        <p className="text-sm font-semibold tracking-tight">
          Off the record — microphone muted, nothing is being captured
          {state.pending && <span className="font-normal text-red-100"> · confirming with the server…</span>}
        </p>
        <p className="text-xs leading-snug text-red-50">{OFF_RECORD_CLAIM}</p>
        {state.error !== undefined && (
          <p className="text-xs font-medium text-amber-200">
            The server has not confirmed this yet ({state.error}). Capture stays off on this device.
          </p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 gap-2">
        {state.error !== undefined && (
          <Button size="sm" variant="outline" className="border-white/40 bg-transparent text-white hover:bg-red-800 hover:text-white" onClick={() => void controller.goOffRecord()}>
            <RotateCw data-icon="inline-start" />
            Retry
          </Button>
        )}
        <Button
          size="sm"
          className="bg-white text-red-800 hover:bg-red-50"
          disabled={state.pending}
          onClick={() => void controller.resume()}
        >
          <Play data-icon="inline-start" />
          Resume the record
        </Button>
      </div>
    </motion.div>
  );
}
