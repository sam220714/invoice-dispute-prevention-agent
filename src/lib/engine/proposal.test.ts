import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadDemoDispute, loadDisputes, loadSplit } from "../data/load";
import { DEMO_SEED } from "../data/split";
import { StubProvider } from "../llm/replay";
import { RuleProposalSchema, type RuleProposal } from "./analysis_schema";
import { assembleContext } from "./context";
import { parseAnalysis, proposalProblems, runAnalysis } from "./llm_call";

const invoice = getInvoice("INV-2026-0847");
const ctx = assembleContext({
  buyer: getBuyer(invoice.buyer_id), invoice, annexure: loadAnnexure(invoice.invoice_id), rules: loadSplit(DEMO_SEED).context,
  disputes: loadDisputes(), message: loadDemoDispute(), receivedOn: "2026-10-06", systemPrompt: "SYSTEM",
});

const proposal = (check: unknown): RuleProposal =>
  RuleProposalSchema.parse({
    type: "format", rule: "A standing requirement stated by the buyer.", quote: "site wise", claim_ids: [],
    check, confidence: "medium", rationale: "stated outright",
  });
const problems = (check: unknown) => proposalProblems(proposal(check), ctx);

describe("a proposed line pattern", () => {
  it("passes when it is anchored and a valid regular expression", () => {
    expect(problems({ kind: "line_field_matches", field: "description", pattern: "^.* - Shamshabad Hub$" })).toEqual([]);
  });

  it("is rejected when it is not anchored", () => {
    expect(problems({ kind: "line_field_matches", field: "po_number", pattern: "MLP/PO/\\d{4}/\\d{4}" }).join()).toContain("must be anchored");
  });

  it("is rejected when it is not even a regular expression", () => {
    expect(problems({ kind: "line_field_matches", field: "description", pattern: "^Shamshabad(" }).join()).toContain("not a valid regular expression");
  });
});

describe("other proposed checks", () => {
  it("accepts a sensible submission window and rejects an impossible one", () => {
    expect(problems({ kind: "invoice_date_window", from_day: 1, to_day: 5 })).toEqual([]);
    expect(problems({ kind: "invoice_date_window", from_day: 9, to_day: 3 })).toHaveLength(1);
    expect(problems({ kind: "invoice_date_window", from_day: 0, to_day: 5 })).toHaveLength(1);
    expect(problems({ kind: "invoice_date_window", from_day: 1, to_day: 40 })).toHaveLength(1);
  });

  it("rejects an implausible payment term and an impossible billing cycle", () => {
    expect(problems({ kind: "payment_terms_days", days: 45 })).toEqual([]);
    expect(problems({ kind: "payment_terms_days", days: 4000 })).toHaveLength(1);
    expect(problems({ kind: "billing_period_cycle", start_day: 26, end_day: 25 })).toEqual([]);
    expect(problems({ kind: "billing_period_cycle", start_day: 0, end_day: 25 })).toHaveLength(1);
  });

  it("lets a manual_review rule through, since there is nothing to enforce", () => {
    expect(problems({ kind: "manual_review", note: "a person must look" })).toEqual([]);
  });

  it("has no vocabulary for the checks v1 dropped", () => {
    for (const kind of ["attachment_required", "annexure_code_series"]) {
      expect(RuleProposalSchema.safeParse({
        type: "format", rule: "A standing requirement stated by the buyer.", quote: "x", claim_ids: [],
        check: { kind }, confidence: "medium", rationale: "x",
      }).success).toBe(false);
    }
  });
});

describe("through the whole call", () => {
  const reply = (pattern: string) => JSON.stringify({
    claims: [{
      claim_id: "C1", claim: "Lines must name the site",
      quote: "Please group them site wise, as our GL posting is done site wise.",
      bucket: "format", target: "all_lines", line_ids: [], matched_rule_id: null,
      match_rationale: "No active rule covers site-wise grouping.",
      proposed_calls: [{ tool: "regroup_lines", group_by: "site_code" }],
      confidence: "high",
    }],
    new_rules: [{
      type: "format", rule: "Every line description must end with the site name.",
      quote: "Please group them site wise, as our GL posting is done site wise.", claim_ids: ["C1"],
      check: { kind: "line_field_matches", field: "description", pattern }, confidence: "medium", rationale: "stated outright",
    }],
    unclear: [],
  });

  it("flags an unanchored learned pattern as a problem with the rule, by position", () => {
    const r = parseAnalysis(reply("Hub$"), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems[0]).toMatch(/^new_rules\[0\]: .*must be anchored/);
  });

  it("shows the model the problem and accepts the corrected pattern", async () => {
    const stub = new StubProvider([reply("Hub$"), reply("^.* - (Shamshabad Hub|Medchal DC|Patancheru Yard)$")]);
    const { analysis, meta } = await runAnalysis(ctx, stub);
    expect(meta.repaired).toBe(true);
    expect(stub.requests[1]!.user).toContain("must be anchored");
    expect(analysis.new_rules[0]!.check).toMatchObject({ kind: "line_field_matches", field: "description" });
  });
});
