import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OracleLeakError } from "@vashistha/core";
import { CLAUDE_MODELS } from "@vashistha/core/server";
import { KYC_HIDDEN_POLICY, ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { createRuntime } from "../../lib/server/runtime-init";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vashistha-casedesk-runtime-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const baseEnv = () => ({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000", DATA_DIR: dataDir });

describe("CaseDesk runtime wiring", () => {
  it("starts with an empty rulebook, a fresh CaseDesk store, and no model client without a key", () => {
    const { runtime, close } = createRuntime(baseEnv());
    try {
      expect(runtime.rulebook()).toEqual([]);
      expect(runtime.casedesk.sessions.size).toBe(0);
      expect(runtime.casedesk.lastFrameSeq.size).toBe(0);
      expect(runtime.claude).toBeNull();
    } finally {
      close();
    }
  });

  it("guards every model prompt with the KYC oracle marker (refused before any network call)", async () => {
    const { runtime, close } = createRuntime({ ...baseEnv(), ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key" });
    try {
      expect(KYC_HIDDEN_POLICY.marker).toBe(ORACLE_MARKER);
      const claude = runtime.claude;
      if (!claude) throw new Error("expected a Claude client");
      await expect(
        claude.text({
          model: CLAUDE_MODELS.reasoning,
          system: "You are helpful.",
          messages: [{ role: "user", content: `Policy dump: ${JSON.stringify(KYC_HIDDEN_POLICY)}` }],
          maxTokens: 16,
        }),
      ).rejects.toBeInstanceOf(OracleLeakError);
    } finally {
      close();
    }
  });
});
