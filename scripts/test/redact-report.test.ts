import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretRegistry, REDACTED } from "../preflight/redact";
import { buildReport, formatHuman, reportFileName, writeReport } from "../preflight/report";
import type { CheckResult } from "../preflight/types";
import { ANTHROPIC_KEY, ELEVEN_KEY, SECRET } from "./support/fakes";

const NONCE = "Zq3x9_kP0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1w";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.conversation-token-value.signature";
const SIGNED_URL = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a1&conversation_signature=cvtkn_abcdef0123456789";

describe("createSecretRegistry", () => {
  it("redacts registered values, including JSON-escaped and URL-encoded forms", () => {
    const secrets = createSecretRegistry([SECRET, "short"]);
    secrets.add('quote"secret-value-123');
    const text = `a ${SECRET} b ${JSON.stringify('quote"secret-value-123')} c ${encodeURIComponent('quote"secret-value-123')} short`;
    const out = secrets.text(text);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("secret-value-123");
    // Values under 8 characters are not treated as secrets.
    expect(out).toContain("short");
  });

  it("redacts sensitive shapes even when the value was never registered", () => {
    const secrets = createSecretRegistry();
    const out = secrets.text(
      `control ⟦ctl:${NONCE}⟧ url ${SIGNED_URL} header Authorization: Bearer abc.def.ghi key sk-ant-api03-zzzz xi-api-key: xyz123`,
    );
    expect(out).not.toContain(NONCE);
    expect(out).not.toContain("cvtkn_abcdef");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("sk-ant-api03-zzzz");
    expect(out).not.toContain("xyz123");
    expect(out).toContain(`⟦ctl:${REDACTED}⟧`);
  });

  it("replaces secret-named keys and redacts every nested string", () => {
    const secrets = createSecretRegistry([SECRET]);
    const out = secrets.value({ token: "anything", nested: [{ nonce: "n", note: `uses ${SECRET}` }], count: 3, ok: true, none: null });
    expect(out).toEqual({ token: REDACTED, nested: [{ nonce: REDACTED, note: `uses ${REDACTED}` }], count: 3, ok: true, none: null });
  });
});

describe("report", () => {
  const leaky: CheckResult[] = [
    {
      id: "voice-skip-turn",
      title: "voice",
      status: "fail",
      ms: 10,
      detail: `sent ⟦ctl:${NONCE}⟧ over ${SIGNED_URL} with token ${TOKEN}`,
      facts: { token: TOKEN, signedUrl: SIGNED_URL, nested: { note: `bearer ${SECRET}`, keys: [ANTHROPIC_KEY, ELEVEN_KEY] } },
    },
    { id: "permissions", title: "checklist", status: "info", ms: 0, detail: "printed below" },
  ];

  it("contains no secret, token, nonce or signed URL anywhere in the JSON", () => {
    const secrets = createSecretRegistry([SECRET, ANTHROPIC_KEY, ELEVEN_KEY]);
    secrets.add(TOKEN);
    const report = buildReport({ startedAt: 0, finishedAt: 1000, target: "https://x.example", options: {}, results: leaky, exitCode: 1, secrets });
    const json = JSON.stringify(report);
    for (const value of [SECRET, ANTHROPIC_KEY, ELEVEN_KEY, TOKEN, NONCE, "conversation_signature", "cvtkn_"]) expect(json).not.toContain(value);
    expect(report.summary).toEqual({ pass: 0, fail: 1, skip: 0, info: 1 });
    expect(report.checklist.length).toBeGreaterThan(0);
  });

  it("human output is redacted too", () => {
    const secrets = createSecretRegistry([SECRET]);
    secrets.add(TOKEN);
    const text = formatHuman(leaky, 1, 1234, secrets, true);
    for (const value of [SECRET, TOKEN, NONCE, "cvtkn_"]) expect(text).not.toContain(value);
    expect(text).toMatch(/^✗ {2}voice-skip-turn {2}voice {2}\(10 ms\)/m);
    expect(text).toMatch(/^i {2}permissions/m);
    expect(text).toContain("PREFLIGHT NOT GREEN: 0 passed, 1 failed, 0 skipped, 1 info (1.2 s)");
    expect(text).toContain("[ ] Use Chrome");
  });

  it("writes docs/evidence-style file names without colons and never overwrites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preflight-report-"));
    const startedAt = Date.UTC(2026, 9, 4, 12, 34, 56, 789);
    expect(reportFileName(startedAt)).toBe("preflight-2026-10-04T12-34-56.789Z.json");
    const secrets = createSecretRegistry([SECRET]);
    const report = buildReport({ startedAt, finishedAt: startedAt + 5, target: null, options: {}, results: leaky, exitCode: 1, secrets });
    const path = await writeReport(join(dir, "evidence"), report, startedAt);
    expect(await readdir(join(dir, "evidence"))).toEqual(["preflight-2026-10-04T12-34-56.789Z.json"]);
    const written = await readFile(path, "utf8");
    expect(JSON.parse(written)).toEqual(report);
    expect(written).not.toContain(SECRET);
    await expect(writeReport(join(dir, "evidence"), report, startedAt)).rejects.toThrow(/EEXIST/);
  });
});
