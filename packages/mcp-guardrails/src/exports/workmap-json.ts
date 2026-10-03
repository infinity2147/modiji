/**
 * Work Map JSON, the core export (plan §7.6): the canonical Work Map as a canonical JSON document.
 * Object keys are sorted at every level and array order is kept, so equal Work Maps always export to
 * the same bytes. Both directions validate against `WorkMapSchema`.
 */
import { WorkMapSchema, type WorkMap } from "@vashistha/core";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const sorted: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) sorted[key] = canonical(child);
  }
  return sorted;
}

/** Canonical JSON text (2-space indent, sorted keys, trailing newline). Throws a ZodError if `workMap` is invalid. */
export function exportWorkMapJson(workMap: WorkMap): string {
  const parsed: Json = WorkMapSchema.parse(workMap);
  return `${JSON.stringify(canonical(parsed), null, 2)}\n`;
}

/** Parses and validates exported Work Map JSON. Throws a SyntaxError or a ZodError. */
export function importWorkMapJson(text: string): WorkMap {
  return WorkMapSchema.parse(JSON.parse(text));
}
