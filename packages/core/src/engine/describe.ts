import type { ActionDef, DomainConfig, Feature } from "../schemas/domain";
import { predicateNode } from "../logic/node";
import { isVarRef, type Operand, type Predicate } from "../schemas/predicate";
import { isUnknown, type ActionId, type FeatureId, type FeatureValue } from "../schemas/primitives";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "Country risk (Northstar list)" → "country risk": short, lower-case, for question templates. */
export function featurePhrase(f: Pick<Feature, "label">): string {
  const label = f.label.replace(/\s*\([^)]*\)/g, "").trim();
  return /^[A-Z][A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** A value as a reviewer would say it: "35%", "36 months", "EUR 18,000", "yes", "not provided". */
export function formatValue(f: Feature | undefined, v: FeatureValue): string {
  if (isUnknown(v)) return "unknown";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v.replaceAll("_", " ");
  const n = NUMBER.format(v);
  if (f?.type !== "number" || f.unit === undefined) return n;
  const unit = f.unit.trim();
  if (unit === "%") return `${n}%`;
  if (/^[A-Z]{3}$/.test(unit)) return `${unit} ${n}`;
  if (unit === "months" && v === 1) return "1 month";
  return `${n} ${unit}`;
}

export function actionPhrase(domain: DomainConfig, action: ActionId): string {
  const def: ActionDef | undefined = domain.actions.find((a) => a.id === action);
  return def === undefined ? action : def.label.charAt(0).toLowerCase() + def.label.slice(1);
}

const OP_TEXT = { "==": "is", "!=": "is not", ">": "above", ">=": "at least", "<": "below", "<=": "at most" } as const;

/** Plain-language rendering of a predicate, e.g. "largest beneficial owner share above 25% and country risk is medium". */
export function describePredicate(p: Predicate, domain: DomainConfig): string {
  const node = predicateNode(p);
  switch (node.key) {
    case "and":
    case "or":
      return node.args.map((c) => wrap(c, domain)).join(` ${node.key} `);
    case "!":
      return `not (${describePredicate(node.args[0], domain)})`;
    case "in": {
      const [o, list] = node.args;
      const f = featureOf(domain, o);
      return `${operandText(domain, o)} is one of ${list.map((v) => formatValue(f, v)).join(", ")}`;
    }
    default: {
      const [l, r] = node.args;
      const f = featureOf(domain, l) ?? featureOf(domain, r);
      const side = (o: Operand): string => (isVarRef(o) ? operandText(domain, o) : formatValue(f, o));
      return `${side(l)} ${OP_TEXT[node.key]} ${side(r)}`;
    }
  }
}

function wrap(p: Predicate, domain: DomainConfig): string {
  const key = predicateNode(p).key;
  const text = describePredicate(p, domain);
  return key === "and" || key === "or" ? `(${text})` : text;
}

function featureOf(domain: DomainConfig, o: Operand): Feature | undefined {
  return isVarRef(o) ? findFeature(domain, o.var) : undefined;
}

function operandText(domain: DomainConfig, o: Operand): string {
  if (!isVarRef(o)) return String(o);
  const f = findFeature(domain, o.var);
  return f === undefined ? o.var : featurePhrase(f);
}

export function findFeature(domain: DomainConfig, id: FeatureId | string): Feature | undefined {
  return domain.features.find((f) => f.id === id);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== "").length;
}

/** Whitespace-normalised substring test used to verify that a model-returned quote is verbatim. */
export function containsQuote(text: string, quote: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const q = norm(quote);
  return q !== "" && norm(text).includes(q);
}
