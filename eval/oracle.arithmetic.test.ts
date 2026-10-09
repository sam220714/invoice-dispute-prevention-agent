/**
 * HARNESS, NOT RUNTIME. This file may read the answer key because it is the
 * oracle: it scores the engine against dataset/qa. It must never be imported
 * from src/, and nothing it reads is ever placed in a prompt.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getInvoice } from "../src/lib/data/load";
import { compareInvoices, recomputeInvoice, toPaise } from "../src/lib/engine/arithmetic";

const here = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(
  readFileSync(join(here, "..", "dataset", "qa", "expected_analysis.json"), "utf-8"),
);

describe("demo arithmetic vs the oracle (expected_analysis.json)", () => {
  const original = getInvoice(expected.invoice_id);
  // Quantities the two business claims resolve to. Here we only prove the
  // arithmetic engine turns them into the right money.
  const OT = { L9: 0, L11: 0 };   // Shamshabad and Patancheru overtime: unauthorised
  const EXITS = { L6: 520 };      // Shamshabad loaders: two exits
  const withQty = (qty: Record<string, number>) =>
    recomputeInvoice({
      ...original,
      lines: original.lines.map((l) => (l.line_id in qty ? { ...l, qty: qty[l.line_id]! } : l)),
    });
  const revised = withQty({ ...OT, ...EXITS });
  const delta = compareInvoices(original, revised);

  it("original total matches", () => {
    expect(toPaise(delta.original_total_inr)).toBe(toPaise(expected.original_invoice_total_inr));
  });

  it("wage reduction is Rs 33,310", () => {
    expect(toPaise(delta.wage_reduction_inr)).toBe(toPaise(expected.wage_reduction_inr));
  });

  it("revised total matches, to the paisa", () => {
    expect(toPaise(delta.revised_total_inr)).toBe(toPaise(expected.revised_invoice_total_inr));
  });

  it("invoice reduction matches, to the paisa", () => {
    expect(toPaise(delta.total_reduction_inr)).toBe(toPaise(expected.total_reduction_inr));
  });

  it("per-claim impacts: OT Rs 19,710 and exits Rs 13,600", () => {
    const ot = compareInvoices(original, withQty(OT)).wage_reduction_inr;
    const exits = compareInvoices(original, withQty(EXITS)).wage_reduction_inr;
    const claims = expected.claims as { lines_affected: string[]; value_impact_inr: number }[];
    expect(ot).toBe(-claims.find((c) => c.lines_affected.includes("L9"))!.value_impact_inr);
    expect(exits).toBe(-claims.find((c) => c.lines_affected.includes("L6"))!.value_impact_inr);
  });
});
