/**
 * HARNESS, NOT RUNTIME. Scores the tool layer against the answer key.
 * Never imported from src/, and nothing read here is put in a prompt.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadSplit } from "../src/lib/data/load";
import { DEMO_SEED } from "../src/lib/data/split";
import { toPaise } from "../src/lib/engine/arithmetic";
import { applyToolCall, createDraft, TOOL_KIND, type ToolCall } from "../src/lib/engine/tools";
import { BUCKET_AUTONOMY } from "../src/lib/schema";

const here = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(
  readFileSync(join(here, "..", "dataset", "qa", "expected_analysis.json"), "utf-8"),
) as {
  invoice_id: string;
  claims: { bucket: "business" | "format"; autonomy: string; lines_affected: string[]; value_impact_inr: number }[];
  revised_invoice_total_inr: number;
  total_reduction_inr: number;
};

describe("autonomy routing vs the oracle", () => {
  it("every claim's autonomy is what its bucket routes to", () => {
    for (const c of expected.claims) expect(c.autonomy).toBe(BUCKET_AUTONOMY[c.bucket]);
  });

  it("the tool layer agrees: business tools need the merchant, the rest do not", () => {
    const businessTools = Object.entries(TOOL_KIND).filter(([, k]) => k === "business").map(([t]) => t).sort();
    expect(businessTools).toEqual(["adjust_line", "defer_line", "remove_line", "set_service_charge_base", "split_invoice"]);
    expect(BUCKET_AUTONOMY.business).toBe("propose_merchant_approves");
  });
});

describe("the demo, driven through the tools", () => {
  const invoice = getInvoice(expected.invoice_id);
  const draft = createDraft({
    invoice, buyer: getBuyer(invoice.buyer_id), annexure: loadAnnexure(invoice.invoice_id), rules: loadSplit(DEMO_SEED).context,
  });

  const proposals: ToolCall[] = [
    { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "Shamshabad OT is not authorised" },
    { tool: "adjust_line", line_id: "L11", field: "qty", value: 0, reason: "Patancheru OT is not authorised" },
    { tool: "adjust_line", line_id: "L6", field: "qty", value: 520, reason: "two loaders exited mid-month" },
  ];

  it("approved by the merchant, they reproduce the oracle's revised total to the paisa", () => {
    let d = draft;
    for (const p of proposals) {
      const r = applyToolCall(d, p, { actor: "merchant" });
      expect(r.result.ok).toBe(true);
      d = r.draft;
    }
    expect(toPaise(d.invoice.totals.grand_total)).toBe(toPaise(expected.revised_invoice_total_inr));
    expect(toPaise(d.baseline.totals.grand_total - d.invoice.totals.grand_total)).toBe(toPaise(expected.total_reduction_inr));
  });

  it("the model alone cannot apply them", () => {
    for (const p of proposals) {
      expect(applyToolCall(draft, p, { actor: "model" }).result.ok).toBe(false);
    }
  });

  it("the audit log explains every change", () => {
    let d = draft;
    for (const p of proposals) d = applyToolCall(d, p, { actor: "merchant" }).draft;
    expect(d.log.map((e) => e.message)).toEqual([
      "L9 qty 54 -> 0: Shamshabad OT is not authorised",
      "L11 qty 92 -> 0: Patancheru OT is not authorised",
      "L6 qty 540 -> 520: two loaders exited mid-month",
    ]);
  });
});
