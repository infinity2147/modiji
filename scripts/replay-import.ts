/**
 * `pnpm replay:import --base <url> --bundle <dir>`
 *
 * Uploads an exported run bundle (pnpm replay:export) to a server's DATA_DIR/replays through the guarded
 * import endpoint (`Authorization: Bearer $CUSTOM_LLM_SECRET`): every listed file, then the manifest;
 * the server re-verifies hashes and the hash chain before moving it into place, and never replaces an
 * existing bundle. The bundle is verified locally first. Reads .env from the repo root (real env wins).
 */
import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MANIFEST_FILE, verifyBundle } from "../apps/web/lib/replay/bundle";

setDefaultResultOrder("ipv4first");

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { base: { type: "string" }, bundle: { type: "string" } }, strict: true });
  if (values.base === undefined || values.bundle === undefined) throw new Error("usage: pnpm replay:import --base <url> --bundle <dir>");
  const dir = isAbsolute(values.bundle) ? values.bundle : resolve(process.env.INIT_CWD ?? process.cwd(), values.bundle);
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const secret = process.env.CUSTOM_LLM_SECRET;
  if (secret === undefined) throw new Error("CUSTOM_LLM_SECRET is not set (the import endpoint is bearer-guarded)");
  const verified = await verifyBundle(dir, basename(dir));
  if (!verified.ok) throw new Error(`the local bundle does not verify: ${verified.reason}`);
  const { manifest } = verified.bundle;
  const headers = { Authorization: `Bearer ${secret}` };
  const url = (path: string) => new URL(`/api/replays/${manifest.bundleId}/import${path}`, values.base).toString();
  for (const path of [...Object.keys(manifest.files), MANIFEST_FILE]) {
    const response = await fetch(url(`/${path}`), { method: "PUT", headers, body: await readFile(join(dir, path)), signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`PUT ${path} → ${response.status} ${await response.text()}`);
  }
  const committed = await fetch(url(""), { method: "POST", headers, signal: AbortSignal.timeout(120_000) });
  const body = await committed.text();
  if (!committed.ok) throw new Error(`import refused → ${committed.status} ${body}`);
  console.info(`${body}\nreplay: ${new URL(`/replay/${manifest.bundleId}`, values.base).toString()}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`replay:import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
