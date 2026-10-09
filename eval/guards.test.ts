/**
 * Structural guards for the non-negotiables. These scan source rather than test
 * behaviour, so a future edit that breaks an invariant fails the build even if
 * every functional test still passes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDatasetPath } from "../src/lib/data/load";
import { AnalysisSchema, ProposedCallSchema } from "../src/lib/engine/analysis_schema";
import { ToolCallSchema } from "../src/lib/engine/tools";
import { AnnexureSchema, CheckSchema, InvoiceSchema, RuleSchema } from "../src/lib/schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(srcDir).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string) => relative(root, f).split(sep).join("/");

describe("invariant 2: nothing in dataset/qa ever enters a prompt", () => {
  // Matches the directory as a path segment or quoted name, e.g. "qa/", '/qa/', "qa".
  const mentionsAnswerKey = /(^|[\\/'"`])qa([\\/'"`]|$)/m;

  it.each([
    "qa/expected_analysis.json",
    "qa/ground_truth_rules.json",
    "QA/expected_analysis.json",
    "./qa/verify.py",
    "annexure_INV-2026-0847.json/../qa/expected_analysis.json",
  ])("the loader refuses %s", (path) => {
    expect(() => resolveDatasetPath(path)).toThrow(/answer key/);
  });

  it("no source file under src/ references the answer-key directory", () => {
    const offenders = sources
      // load.ts names the directory only to refuse it; the loader test above covers its behaviour.
      .filter((f) => rel(f) !== "src/lib/data/load.ts")
      .filter((f) => mentionsAnswerKey.test(readFileSync(f, "utf-8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("only load.ts touches the filesystem", () => {
    const readers = sources
      .filter((f) => /from\s+["'](node:)?fs(\/promises)?["']/.test(readFileSync(f, "utf-8")))
      .map(rel)
      .filter((f) => !f.endsWith(".test.ts"));
    expect(readers).toEqual(["src/lib/data/load.ts"]);
  });

  it("the harness is never imported from src/", () => {
    const imports = sources.filter((f) => /from\s+["'][./]*\/?eval\//.test(readFileSync(f, "utf-8")));
    expect(imports.map(rel)).toEqual([]);
  });
});

describe("invariant 1: the LLM never emits a number", () => {
  // Money enters the system only through recomputeInvoice(). The shapes a model
  // is allowed to author (a rule's check) must therefore have no money field.
  // Compared as whole snake_case tokens, so "times_corroborated" does not trip on "rate".
  const MONEY_TOKENS = new Set([
    "amount", "total", "inr", "price", "rupee", "rupees", "charge", "cgst", "sgst", "gst", "wages", "rate",
  ]);
  const moneyKey = { test: (k: string) => k.toLowerCase().split("_").some((t) => MONEY_TOKENS.has(t)) };

  function keysOf(schema: unknown, acc = new Set<string>()): Set<string> {
    const s = schema as { _def?: Record<string, unknown>; shape?: Record<string, unknown> };
    const shape = s.shape ?? (s._def?.shape as (() => Record<string, unknown>) | undefined)?.();
    if (shape) for (const [k, v] of Object.entries(shape)) (acc.add(k), keysOf(v, acc));
    const def = s._def;
    if (def?.options) for (const o of def.options as unknown[]) keysOf(o, acc);
    if (def?.innerType) keysOf(def.innerType, acc);
    if (def?.type) keysOf(def.type, acc);
    return acc;
  }

  it("a model-authored check has no money-shaped field", () => {
    const keys = [...keysOf(CheckSchema)].filter((k) => k !== "kind");
    expect(keys.filter((k) => moneyKey.test(k))).toEqual([]);
  });

  it("a model-authored tool call has no money-shaped field", () => {
    const keys = [...keysOf(ToolCallSchema)].filter((k) => k !== "tool");
    expect(keys.filter((k) => moneyKey.test(k))).toEqual([]);
  });

  it("what the model returns has no money-shaped field", () => {
    const keys = [...keysOf(AnalysisSchema), ...keysOf(ProposedCallSchema)].filter((k) => k !== "tool");
    expect(keys.filter((k) => moneyKey.test(k))).toEqual([]);
  });

  it("every tool-call schema is strict, so a smuggled field is rejected rather than dropped", () => {
    const options = (ToolCallSchema as unknown as { options: { _def: { unknownKeys: string } }[] }).options;
    expect(options.length).toBeGreaterThan(0);
    expect(options.filter((o) => o._def.unknownKeys !== "strict")).toEqual([]);
  });

  it("the money fields that do exist live only on dataset-shaped objects", () => {
    // Sanity check on the guard itself: the invoice schema must trip it.
    expect([...keysOf(InvoiceSchema)].some((k) => moneyKey.test(k))).toBe(true);
    // ...and a rule, which a model authors, must not.
    expect([...keysOf(RuleSchema)].filter((k) => moneyKey.test(k))).toEqual([]);
    expect(AnnexureSchema).toBeDefined();
  });
});
