/**
 * Oracle-leak detection (plan §8: the hidden policy never reaches a client bundle or a model prompt).
 *
 * Convention for every `*.oracle.server.ts` file in the repo (node_modules, dot-directories such as
 * `.next`/`.git`, and this scanner's own test fixtures excluded):
 *   (a) its first import is `import "server-only";` — Next.js then refuses to build any client
 *       bundle that reaches the module (first line of defence);
 *   (b) it exports exactly one canary `export const ORACLE_MARKER = "oracle:<domainId>:<hex>";`
 *       (domainId is a core SymbolId, hex is ≥16 random lowercase hex chars, unique per module);
 *   (c) the module references ORACLE_MARKER outside its declaration — embed it in the exported
 *       HiddenPolicy (e.g. `{ marker: ORACLE_MARKER, ... }`) so tree-shaking cannot drop the canary
 *       while keeping the oracle logic.
 * If a marker ever appears in client output (`scanForMarkers`) or in a prompt (`findMarkersInText`),
 * the oracle leaked (second line of defence).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { SymbolIdSchema } from "@vashistha/core";

/** The model-prompt guard lives in core (`oracle-guard.ts`); re-exported for the existing tests. */
export { findMarkersInText } from "@vashistha/core";

export type OracleModule = { file: string; marker: string };
export type MarkerHit = { file: string; marker: string };

const ORACLE_FILE_SUFFIX = ".oracle.server.ts";
const MARKER_EXPORT_NAME = "ORACLE_MARKER";
const MARKER_PATTERN = /^oracle:([^:]+):([0-9a-f]{16,})$/;
/** The scanner's own deliberately leaky fixtures, relative to the repo root; only this exact directory is skipped. */
const SCANNER_FIXTURES_DIR = path.join("apps", "web", "test", "fixtures");

/** Extensions never worth reading for an ASCII canary (images, fonts, media, archives, wasm). */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".wav", ".ogg",
  ".wasm", ".zip", ".gz", ".br", ".pdf",
]);

async function walkFiles(dir: string, skipDir: (fullPath: string, name: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const full = path.join(dir, entry.name);
      // Symlinks are not followed: pnpm links would re-enter the workspace and could loop.
      if (entry.isDirectory()) return skipDir(full, entry.name) ? [] : walkFiles(full, skipDir);
      return entry.isFile() ? [full] : [];
    }),
  );
  return nested.flat().sort();
}

/** Validates one oracle module's source against the convention above; throws on any violation. */
export function parseOracleModule(file: string, source: string): OracleModule {
  function fail(reason: string): never {
    throw new Error(`${file} violates the oracle convention: ${reason}`);
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const firstImport = sf.statements.find(ts.isImportDeclaration);
  if (
    !firstImport ||
    firstImport.importClause !== undefined ||
    !ts.isStringLiteral(firstImport.moduleSpecifier) ||
    firstImport.moduleSpecifier.text !== "server-only"
  ) {
    fail('the first import must be `import "server-only";`');
  }

  const markerDeclarations = sf.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) =>
      statement.declarationList.declarations.map((declaration) => ({ statement, declaration })),
    )
    .filter(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === MARKER_EXPORT_NAME);
  const [only] = markerDeclarations;
  if (markerDeclarations.length !== 1 || !only) {
    fail(`expected exactly one ${MARKER_EXPORT_NAME} declaration, found ${markerDeclarations.length}`);
  }
  const { statement, declaration } = only;
  const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  if (!isExported || !isConst || !declaration.initializer || !ts.isStringLiteral(declaration.initializer)) {
    fail(`${MARKER_EXPORT_NAME} must be \`export const ${MARKER_EXPORT_NAME} = "<string literal>";\``);
  }

  const marker = declaration.initializer.text;
  const match = MARKER_PATTERN.exec(marker);
  if (!match || !SymbolIdSchema.safeParse(match[1]).success) {
    fail(`${MARKER_EXPORT_NAME} must match "oracle:<domainId>:<≥16 lowercase hex>", got "${marker}"`);
  }

  let references = 0;
  const countReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === MARKER_EXPORT_NAME && node !== declaration.name) references += 1;
    ts.forEachChild(node, countReferences);
  };
  countReferences(sf);
  if (references === 0) {
    fail(`${MARKER_EXPORT_NAME} must be referenced by the oracle (e.g. embedded in the exported policy)`);
  }

  return { file, marker };
}

/** Finds every oracle module under `repoRoot` and validates it; throws on violations or duplicate markers. */
export async function discoverOracleModules(repoRoot: string): Promise<OracleModule[]> {
  const files = await walkFiles(
    repoRoot,
    (fullPath, name) =>
      name.startsWith(".") || name === "node_modules" || path.relative(repoRoot, fullPath) === SCANNER_FIXTURES_DIR,
  );
  const modules = await Promise.all(
    files
      .filter((file) => file.endsWith(ORACLE_FILE_SUFFIX))
      .map(async (file) => parseOracleModule(file, await readFile(file, "utf8"))),
  );
  const seen = new Map<string, string>();
  for (const { file, marker } of modules) {
    const previous = seen.get(marker);
    if (previous) throw new Error(`Duplicate ORACLE_MARKER "${marker}" in ${previous} and ${file}`);
    seen.set(marker, file);
  }
  return modules;
}

/** Recursively lists files under `dir` that could carry text (binary formats skipped by extension). */
export async function listTextFiles(dir: string): Promise<string[]> {
  const files = await walkFiles(dir, () => false);
  return files.filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

export async function scanFilesForMarkers(files: readonly string[], markers: readonly string[]): Promise<MarkerHit[]> {
  if (markers.length === 0) return [];
  const perFile = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file);
      return markers.filter((marker) => content.includes(marker)).map((marker) => ({ file, marker }));
    }),
  );
  return perFile.flat();
}

/** Every marker occurrence in any text file under `dir`. */
export async function scanForMarkers(dir: string, markers: readonly string[]): Promise<MarkerHit[]> {
  return scanFilesForMarkers(await listTextFiles(dir), markers);
}
