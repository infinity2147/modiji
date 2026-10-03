/**
 * The production `VisionExtractor`: one Claude Haiku 4.5 structured-output call per frame, built by
 * `buildExtractionRequest` from the PUBLIC domain config, the previous vision snapshot and the
 * redacted images. `runtime.claude` refuses any request carrying a hidden-policy marker, so the
 * oracle cannot reach this prompt. Loaded by the composition root only.
 */
import type { Claude } from "@vashistha/core/server";
import { buildExtractionRequest } from "@vashistha/perception/extraction";
import type { VisionExtractor } from "./service";

export function createClaudeVisionExtractor(claude: Claude): VisionExtractor {
  return async (input) => {
    const { request } = buildExtractionRequest(input);
    const { output } = await claude.structured(request);
    return output;
  };
}
