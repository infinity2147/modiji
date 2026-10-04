/**
 * Builds the vision channel for the composition root (runtime-init.ts only). Extraction runs when
 * `runtime.claude` exists and `VISION_EXTRACTION` is not `off`. The switch lets a deployment (or the
 * e2e suite, whose ANTHROPIC_API_KEY is a placeholder) keep frame capture and storage while never
 * calling the model; the vision state then reports `unavailable` / `disabled`.
 */
import { z } from "zod";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { EnvError, type Claude, type Ledger } from "@vashistha/core/server";
import { warmUpExtraction } from "@vashistha/perception/extraction";
import { createClaudeVisionExtractor } from "./extractor";
import type { ReadPreparer } from "./prepare";
import { CASEDESK_SCREEN } from "./screen-profile";
import { createPerceptionService, type PerceptionService } from "./service";

const VisionSwitchSchema = z.enum(["on", "off"]).default("on");

export function createPerception(options: {
  source: Readonly<Record<string, string | undefined>>;
  ledger: Ledger;
  claude: Claude | null;
  /** Frame decoding and read planning: the vision worker thread (workers/vision.ts). */
  prepare: ReadPreparer;
}): PerceptionService {
  const visionSwitch = VisionSwitchSchema.safeParse(options.source.VISION_EXTRACTION?.trim() || undefined);
  if (!visionSwitch.success)
    throw new EnvError("Invalid server environment:\n  VISION_EXTRACTION: invalid (on or off)", ["VISION_EXTRACTION"]);
  const { claude } = options;
  const on = visionSwitch.data === "on" && claude !== null;
  // Compile the output grammars now, not on a reviewer's first frame (best effort: a failure only costs that latency).
  if (on)
    warmUpExtraction(claude, KYC_DOMAIN, CASEDESK_SCREEN).catch((error: unknown) =>
      console.warn(`[perception] extraction warm-up failed: ${error instanceof Error ? error.name : "error"}`),
    );
  return createPerceptionService({
    ledger: options.ledger,
    domain: KYC_DOMAIN,
    profile: CASEDESK_SCREEN,
    extractor: on
      ? { run: createClaudeVisionExtractor(claude) }
      : { unavailable: visionSwitch.data === "off" ? "disabled" : "no_api_key" },
    prepare: options.prepare,
    now: Date.now,
    log: console,
  });
}
