/**
 * Builds the vision channel for the composition root (runtime-init.ts only). Extraction runs when
 * `runtime.claude` exists and `VISION_EXTRACTION` is not `off`. The switch lets a deployment (or the
 * e2e suite, whose ANTHROPIC_API_KEY is a placeholder) keep frame capture and storage while never
 * calling the model; the vision state then reports `unavailable` / `disabled`.
 */
import { z } from "zod";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { EnvError, type Claude, type Ledger } from "@vashistha/core/server";
import { createClaudeVisionExtractor } from "./extractor";
import { createPerceptionService, type PerceptionService } from "./service";

const VisionSwitchSchema = z.enum(["on", "off"]).default("on");

export function createPerception(options: {
  source: Readonly<Record<string, string | undefined>>;
  ledger: Ledger;
  claude: Claude | null;
}): PerceptionService {
  const visionSwitch = VisionSwitchSchema.safeParse(options.source.VISION_EXTRACTION?.trim() || undefined);
  if (!visionSwitch.success)
    throw new EnvError("Invalid server environment:\n  VISION_EXTRACTION: invalid (on or off)", ["VISION_EXTRACTION"]);
  return createPerceptionService({
    ledger: options.ledger,
    domain: KYC_DOMAIN,
    extractor:
      visionSwitch.data === "off"
        ? { unavailable: "disabled" }
        : options.claude === null
          ? { unavailable: "no_api_key" }
          : { run: createClaudeVisionExtractor(options.claude) },
    now: Date.now,
    log: console,
  });
}
