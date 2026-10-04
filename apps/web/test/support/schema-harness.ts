/**
 * Schema-versioning test support: a fake Haiku that answers the concept re-read prompt per case (behind
 * the real `createClaude`, so the oracle guard and structured-output validation run as in production),
 * the real re-reader over an in-memory frame store, and `SchemaDeps` around a test ledger.
 */
import { createClaude, type Claude, type ClaudeClient, type Ledger } from "@vashistha/core/server";
import { engineConfig } from "@vashistha/core";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { BACKFILL_SYSTEM, type BackfillOutput } from "@vashistha/perception/backfill";
import type { CaseDeskStore } from "../../lib/server/casedesk/session";
import type { InterviewStore } from "../../lib/server/interview/engine-state";
import { createSchemaStore, type SchemaDeps } from "../../lib/server/schema/deps";
import { createConceptReread, type FrameLoader } from "../../lib/server/schema/reread";
import { message } from "./debrief-harness";

type CreateParams = Parameters<ClaudeClient["messages"]["create"]>[0];

/** What the fake vision model reads per case id; "error" fails the call (an outage). Unlisted cases are "not visible". */
export type RereadScript = Record<string, BackfillOutput | "error">;

export type RereadCall = { caseId: string; images: number; text: string };

function userText(params: CreateParams): { text: string; images: number } {
  const content = params.messages[0]?.content ?? "";
  if (typeof content === "string") return { text: content, images: 0 };
  return {
    text: content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
    images: content.filter((b) => b.type === "image").length,
  };
}

/** A fake Anthropic client: the re-read prompt is answered from `script`; anything else goes to `other` (or fails). */
export function rereadClient(script: RereadScript, calls: RereadCall[], other?: ClaudeClient): ClaudeClient {
  return {
    messages: {
      create: (params) => {
        const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
        if (system !== BACKFILL_SYSTEM) return other === undefined ? Promise.reject(new Error("unexpected prompt")) : other.messages.create(params);
        const { text, images } = userText(params);
        const caseId = /Case: (NS-\d{4}-\d{4})/.exec(text)?.[1] ?? "";
        calls.push({ caseId, images, text });
        const answer = script[caseId] ?? { visible: false, value: null, evidence: "" };
        if (answer === "error") return Promise.reject(new Error("vision outage"));
        return Promise.resolve(message(JSON.stringify(answer)));
      },
    },
  };
}

export function fakeClaude(client: ClaudeClient): Claude {
  return createClaude({ client, forbiddenMarkers: [ORACLE_MARKER] });
}

/** Stored redacted frames: every frame id resolves to a few PNG bytes (the fake model never looks at them). */
export const anyFrame: FrameLoader = () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

export const quiet = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a) };

export function schemaDeps(input: {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  interview: InterviewStore;
  claude: Claude | null;
  frames?: FrameLoader;
  now?: () => number;
}): SchemaDeps {
  return {
    ledger: input.ledger,
    casedesk: input.casedesk,
    interview: input.interview,
    engineConfig: engineConfig(),
    reread: input.claude === null ? null : createConceptReread(input.claude, input.frames ?? anyFrame, quiet),
    store: createSchemaStore(),
    now: input.now ?? Date.now,
    log: quiet,
  };
}
