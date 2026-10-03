/**
 * Human output and the JSON evidence report. Everything leaving the process goes through the secret registry,
 * so a value registered during the run (or matching a sensitive pattern) cannot be printed or written.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PERMISSIONS_CHECKLIST } from "./checks/permissions";
import type { SecretRegistry } from "./redact";
import type { CheckResult, CheckStatus, Facts } from "./types";

const SYMBOL: Record<CheckStatus, string> = { pass: "✓", fail: "✗", skip: "–", info: "i" };

export function formatResultLine(result: CheckResult, idWidth = 15): string {
  const [first = "", ...rest] = result.detail.split("\n");
  const head = `${SYMBOL[result.status]}  ${result.id.padEnd(idWidth)}  ${result.title}  (${result.ms} ms)${first ? `  ${first}` : ""}`;
  return [head, ...rest.map((line) => `      ${line}`)].join("\n");
}

export type Summary = { pass: number; fail: number; skip: number; info: number };

export function summarise(results: readonly CheckResult[]): Summary {
  const summary: Summary = { pass: 0, fail: 0, skip: 0, info: 0 };
  for (const r of results) summary[r.status] += 1;
  return summary;
}

export function formatSummary(results: readonly CheckResult[], exitCode: number, totalMs: number): string {
  const s = summarise(results);
  const verdict = exitCode === 0 ? "PREFLIGHT GREEN" : "PREFLIGHT NOT GREEN";
  return `${verdict}: ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped, ${s.info} info (${(totalMs / 1000).toFixed(1)} s)`;
}

export function formatChecklist(): string {
  return ["Demo machine checklist (not verified by this script):", ...PERMISSIONS_CHECKLIST.map((item) => `  [ ] ${item}`)].join("\n");
}

/** Whole human report; redacted once more as a last line of defence. */
export function formatHuman(
  results: readonly CheckResult[],
  exitCode: number,
  totalMs: number,
  secrets: SecretRegistry,
  includeChecklist: boolean,
): string {
  const width = Math.max(...results.map((r) => r.id.length), 2);
  const parts = [...results.map((r) => formatResultLine(r, width)), "", formatSummary(results, exitCode, totalMs)];
  if (includeChecklist) parts.push("", formatChecklist());
  return secrets.text(parts.join("\n"));
}

export type PreflightReport = {
  tool: "vashistha-preflight";
  startedAt: string;
  finishedAt: string;
  target: string | null;
  options: Facts;
  exitCode: number;
  summary: Summary;
  results: CheckResult[];
  checklist: string[];
};

export function buildReport(input: {
  startedAt: number;
  finishedAt: number;
  target: string | null;
  options: Facts;
  results: readonly CheckResult[];
  exitCode: number;
  secrets: SecretRegistry;
}): PreflightReport {
  const report: PreflightReport = {
    tool: "vashistha-preflight",
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    target: input.target,
    options: input.options,
    exitCode: input.exitCode,
    summary: summarise(input.results),
    results: [...input.results],
    checklist: [...PERMISSIONS_CHECKLIST],
  };
  return input.secrets.value(report);
}

/** `preflight-<ISO timestamp>.json`, with `:` replaced so the name is portable. */
export function reportFileName(startedAt: number): string {
  return `preflight-${new Date(startedAt).toISOString().replaceAll(":", "-")}.json`;
}

export async function writeReport(dir: string, report: PreflightReport, startedAt: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, reportFileName(startedAt));
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return path;
}
