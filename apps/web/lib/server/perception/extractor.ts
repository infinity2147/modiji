/**
 * The production `VisionExtractor`: one Claude Haiku 4.5 structured-output call per frame, for the
 * read `prepareRead` planned (full frame or local crop, from the PUBLIC domain config, the declared
 * screen profile and the previous reading). `runtime.claude` refuses any request carrying a
 * hidden-policy marker, so the oracle cannot reach this prompt. Loaded by the composition root only.
 */
import type { Claude } from "@vashistha/core/server";
import { executeRead } from "@vashistha/perception/extraction";
import type { VisionExtractor } from "./service";

export function createClaudeVisionExtractor(claude: Claude): VisionExtractor {
  return async (read) => (await executeRead(read, claude)).reading;
}
