import { DomainConfigSchema, type DomainConfig } from "../schemas/domain";
import { typecheckPredicate } from "../logic/typecheck";

/** `path` is a JSON pointer into the parsed input. */
export type DomainIssue = { path: string; message: string };

export class DomainConfigError extends Error {
  readonly issues: DomainIssue[];
  constructor(issues: DomainIssue[]) {
    super(`invalid domain config:\n${issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "DomainConfigError";
    this.issues = issues;
  }
}

/**
 * Validates the shape with `DomainConfigSchema`, then (only if the shape is valid) cross-checks
 * ids, references, bounds and constraint predicates. All issues are collected.
 */
export function parseDomainConfig(input: unknown): { ok: true; domain: DomainConfig } | { ok: false; issues: DomainIssue[] } {
  const parsed = DomainConfigSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: pointer(i.path), message: i.message })) };
  const issues = crossCheck(parsed.data);
  return issues.length === 0 ? { ok: true, domain: parsed.data } : { ok: false, issues };
}

export function loadDomainConfig(input: unknown): DomainConfig {
  const result = parseDomainConfig(input);
  if (!result.ok) throw new DomainConfigError(result.issues);
  return result.domain;
}

function crossCheck(d: DomainConfig): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const featureIds = new Set<string>(d.features.map((f) => f.id));
  const actionIds = new Set<string>(d.actions.map((a) => a.id));

  checkUnique(d.features.map((f) => f.id), (i) => `/features/${i}/id`, "feature id", issues);
  d.features.forEach((f, i) => {
    const at = `/features/${i}`;
    if (f.type === "number") {
      if (f.min > f.max) issues.push({ path: `${at}/max`, message: `max (${f.max}) is less than min (${f.min})` });
      if (f.integer)
        for (const bound of ["min", "max"] as const)
          if (!Number.isInteger(f[bound]))
            issues.push({ path: `${at}/${bound}`, message: `${bound} (${f[bound]}) must be an integer for an integer feature` });
    } else if (f.type === "enum") {
      checkUnique(f.values, (k) => `${at}/values/${k}`, "enum value", issues);
    }
  });

  checkUnique(d.actions.map((a) => a.id), (i) => `/actions/${i}/id`, "action id", issues);
  d.actions.forEach((a, i) => {
    const params = a.params ?? [];
    checkUnique(params.map((p) => p.id), (k) => `/actions/${i}/params/${k}/id`, "param id", issues);
    params.forEach((p, k) => {
      const at = `/actions/${i}/params/${k}`;
      if (p.type === "enum" && p.values === undefined) issues.push({ path: at, message: `enum param "${p.id}" requires values` });
      if (p.type === "string" && p.values !== undefined)
        issues.push({ path: `${at}/values`, message: `string param "${p.id}" must not declare values` });
      if (p.values !== undefined) checkUnique(p.values, (j) => `${at}/values/${j}`, "param value", issues);
    });
  });

  checkUnique(d.decisionFamilies.map((f) => f.id), (i) => `/decisionFamilies/${i}/id`, "decision family id", issues);
  d.decisionFamilies.forEach((f, i) =>
    f.actions.forEach((a, k) => {
      if (!actionIds.has(a)) issues.push({ path: `/decisionFamilies/${i}/actions/${k}`, message: `unknown action "${a}"` });
    }),
  );

  d.criticalFields.forEach((id, i) => {
    if (!featureIds.has(id)) issues.push({ path: `/criticalFields/${i}`, message: `unknown feature "${id}"` });
  });

  d.domainConstraints.forEach((c, i) => {
    for (const issue of typecheckPredicate(c, d.features))
      issues.push({ path: `/domainConstraints/${i}${issue.path}`, message: issue.message });
  });

  return issues;
}

/** Reports every repeat of an earlier key, pointing back at its first occurrence. */
function checkUnique(keys: readonly string[], pathOf: (i: number) => string, what: string, issues: DomainIssue[]): void {
  const first = new Map<string, number>();
  keys.forEach((key, i) => {
    const j = first.get(key);
    if (j === undefined) first.set(key, i);
    else issues.push({ path: pathOf(i), message: `duplicate ${what} "${key}" (first at ${pathOf(j)})` });
  });
}

function pointer(segments: readonly PropertyKey[]): string {
  return segments.map((s) => `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}
