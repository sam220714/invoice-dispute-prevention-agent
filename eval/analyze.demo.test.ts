/**
 * HARNESS, NOT RUNTIME. The orchestrator scored against the answer key: a
 * correct model reply (see demo_reply.ts) goes through processAnalysis(), and the
 * money that comes out must match dataset/qa/expected_analysis.json to the paisa.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processAnalysis } from "../src/lib/engine/analyze";
import { AnalysisSchema } from "../src/lib/engine/analysis_schema";
import { assembleContext } from "../src/lib/engine/context";
import { demoInput, demoReply, stubMeta } from "./demo_reply";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = JSON.parse(readFileSync(join(root, "dataset", "qa", "expected_analysis.json"), "utf-8"));

const run = (reply = demoReply) => {
  const inp = demoInput();
  return processAnalysis(inp, assembleContext(inp), reply, stubMeta);
};

describe("processAnalysis on the demo reply", () => {
  const result = run();

  it("reproduces the oracle's money to the paisa", () => {
    expect(result.money.wage_reduction_inr).toBe(expected.wage_reduction_inr);
    expect(result.money.total_reduction_inr).toBe(expected.total_reduction_inr);
    expect(result.money.original_total_inr).toBe(expected.original_invoice_total_inr);
    expect(result.money.revised_total_inr).toBe(expected.revised_invoice_total_inr);
    expect(result.money.collectable_now_inr).toBe(expected.collectable_now_inr);
  });

  it("prices the business claims at the oracle's wage impact", () => {
    const business = result.outcomes.filter((o) => o.claim.bucket === "business");
    expect(business.map((o) => -o.impact!.wage_reduction_inr)).toEqual(
      expected.claims.filter((c: { bucket: string }) => c.bucket === "business").map((c: { value_impact_inr: number }) => c.value_impact_inr),
    );
  });

  it("stages business claims and auto-applies format ones", () => {
    expect(result.outcomes.map((o) => o.status)).toEqual(["proposed", "proposed", "applied", "applied", "applied"]);
    expect(result.staged.map((s) => s.claim_id)).toEqual(["C1", "C2"]);
    expect(result.after_fixes.format).toHaveLength(0);
  });

  it("never applies a business change to the draft", () => {
    expect(result.draft.invoice.totals.grand_total).toBe(expected.original_invoice_total_inr);
  });

  it("applies the format fixes to the draft: PO and SAC on every line, grouped by site", () => {
    const lines = result.draft.invoice.lines;
    expect(lines.every((l) => l.po_number === "MLP/PO/2026/3318" && l.sac === "998519")).toBe(true);
    expect(lines.map((l) => l.site_code)).toEqual(["SH", "SH", "SH", "SH", "MD", "MD", "MD", "MD", "PY", "PY", "PY"]);
  });

  it("says four of five were foreseeable, and that the linter would have caught them", () => {
    expect(result.foreseen).toMatchObject({ matched: 4, total: 5 });
    expect(result.outcomes.filter((o) => o.foresight?.linter_flagged)).toHaveLength(4);
    expect(result.foreseen.rule_ids).toEqual(["MER-R1", "MER-R3", "MER-R5", "MER-R6"]);
  });

  it("verifies every quantity against the annexure", () => {
    const checks = result.outcomes.flatMap((o) => o.quantity_checks);
    expect(checks.map((c) => [c.line_id, c.final_qty, c.verdict])).toEqual([
      ["L9", 0, "verified"],
      ["L11", 0, "verified"],
      ["L6", 520, "verified"],
    ]);
  });

  it("flags both new rules as news, not duplicates", () => {
    expect(result.proposed_rules.map((r) => r.duplicate_of)).toEqual([null, null]);
  });
});

describe("a claim the tools cannot act on", () => {
  const withHuman = () => {
    const reply = structuredClone(demoReply);
    // The model hears the exit objection but cannot say which quantity to set.
    Object.assign(reply.claims[1]!, { needs_human: true, proposed_calls: [] });
    return run(AnalysisSchema.parse(reply));
  };

  it("is reported as needing a person, not dropped", () => {
    const result = withHuman();
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes[1]!.status).toBe("needs_human");
    expect(result.outcomes[1]!.steps).toEqual([]);
  });

  it("still counts as foreseeable, because the rule it matched still stands", () => {
    const result = withHuman();
    expect(result.outcomes[1]!.foresight?.rule_id).toBe("MER-R6");
    expect(result.foreseen).toMatchObject({ matched: 4, total: 5 });
  });

  it("is never staged for approval and moves no money", () => {
    const result = withHuman();
    expect(result.staged.map((s) => s.claim_id)).toEqual(["C1"]);
    expect(result.money.wage_reduction_inr).toBe(19710); // the overtime claim alone
  });
});

describe("the engine overrules a wrong quantity", () => {
  it("replaces 518 with the 520 the annexure supports, and says so", () => {
    const reply = structuredClone(demoReply);
    (reply.claims[1]!.proposed_calls[0] as { value: number }).value = 518;
    const result = run(AnalysisSchema.parse(reply));

    const c = result.outcomes[1]!.quantity_checks[0]!;
    expect(c).toMatchObject({ model_qty: 518, engine_qty: 520, final_qty: 520, verdict: "corrected" });
    expect(result.money.wage_reduction_inr).toBe(expected.wage_reduction_inr);
    expect(result.outcomes[1]!.calls[0]).toMatchObject({ value: 520 });
  });

  it("caps overtime at the hours authorised at that site, not at the invoice-wide figure", () => {
    const reply = structuredClone(demoReply);
    (reply.claims[0]!.proposed_calls[0] as { value: number }).value = 40; // the model reads "40 hours" and applies it to Shamshabad
    const result = run(AnalysisSchema.parse(reply));
    expect(result.outcomes[0]!.quantity_checks[0]).toMatchObject({ line_id: "L9", model_qty: 40, engine_qty: 0, verdict: "corrected" });
    expect(result.money.wage_reduction_inr).toBe(expected.wage_reduction_inr);
  });

  it("refuses a dispute that would raise a quantity", () => {
    const reply = structuredClone(demoReply);
    (reply.claims[0]!.proposed_calls[0] as { value: number }).value = 500;
    const result = run(AnalysisSchema.parse(reply));
    expect(result.outcomes[0]!.status).toBe("rejected");
    expect(result.staged.map((s) => s.claim_id)).toEqual(["C2"]);
  });
});
