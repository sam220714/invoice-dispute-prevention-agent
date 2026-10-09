import { describe, expect, it } from "vitest";
import { AnalysisSchema, ClaimSchema, ProposedCallSchema, RuleProposalSchema, verifyQuotes, type Analysis } from "./analysis_schema";
import { ToolCallSchema } from "./tools";

const otCall = { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "no authorisation at this site" };
const claim = (over: Record<string, unknown> = {}) => ({
  claim_id: "C1", claim: "Overtime is not authorised", quote: "Kindly remove the unauthorised portion.",
  bucket: "business", target: "lines", line_ids: ["L9"], matched_rule_id: "MER-R5",
  match_rationale: "The rule says unreferenced OT is struck off.", proposed_calls: [otCall], confidence: "high", ...over,
});
const analysis = (over: Record<string, unknown> = {}) => ({ claims: [claim()], new_rules: [], unclear: [], ...over });

describe("a valid analysis", () => {
  it("parses", () => {
    expect(AnalysisSchema.safeParse(analysis()).success).toBe(true);
  });

  it("may be empty: a message with no objection is not an error", () => {
    expect(AnalysisSchema.safeParse({ claims: [], new_rules: [], unclear: [] }).success).toBe(true);
  });

  it("allows a claim that matches no existing rule", () => {
    expect(ClaimSchema.safeParse(claim({ matched_rule_id: null })).success).toBe(true);
  });
});

describe("the model cannot smuggle in money", () => {
  it.each([
    ["a claim", () => ClaimSchema.safeParse(claim({ amount: 19710 }))],
    ["a claim's impact", () => ClaimSchema.safeParse(claim({ value_impact_inr: -19710 }))],
    ["a tool call", () => ProposedCallSchema.safeParse({ ...otCall, total: 5400 })],
    ["the analysis", () => AnalysisSchema.safeParse({ ...analysis(), revised_total_inr: 2584089 })],
  ])("rejects a money field on %s", (_what, parse) => {
    expect(parse().success).toBe(false);
  });

  it("rejects a rate change: adjust_line is quantity only", () => {
    expect(ProposedCallSchema.safeParse({ ...otCall, field: "rate" }).success).toBe(false);
  });
});

describe("bucket and tool must agree", () => {
  const formatCall = { tool: "set_field", field: "sac", value: "998519" };

  it("a business claim cannot be fixed with a format tool", () => {
    expect(ClaimSchema.safeParse(claim({ proposed_calls: [formatCall] })).success).toBe(false);
  });

  it("a format claim cannot use a business tool, and can use format tools", () => {
    expect(ClaimSchema.safeParse(claim({ bucket: "format", target: "all_lines", line_ids: [], proposed_calls: [otCall] })).success).toBe(false);
    expect(ClaimSchema.safeParse(claim({ bucket: "format", target: "all_lines", line_ids: [], proposed_calls: [formatCall, { tool: "apply_template" }] })).success).toBe(true);
  });

  it("there is no evidence bucket in v1, and no task tool", () => {
    expect(ClaimSchema.safeParse(claim({ bucket: "evidence", target: "all_lines", line_ids: [] })).success).toBe(false);
    expect(ProposedCallSchema.safeParse({ tool: "create_task", owner: "compliance", description: "Attach the challans" }).success).toBe(false);
  });

  it("a claim needs at least one proposed call", () => {
    expect(ClaimSchema.safeParse(claim({ proposed_calls: [] })).success).toBe(false);
  });
});

describe("a claim the tools cannot act on", () => {
  it("stays a claim, keeps its matched rule, and carries no calls", () => {
    const c = ClaimSchema.safeParse(claim({ needs_human: true, proposed_calls: [], matched_rule_id: "YOG-R5" }));
    expect(c.success).toBe(true);
  });

  it("may not also propose calls, because there is nothing to execute", () => {
    expect(ClaimSchema.safeParse(claim({ needs_human: true })).success).toBe(false);
  });

  it("needs_human false is the same as leaving it out", () => {
    expect(ClaimSchema.safeParse(claim({ needs_human: false, proposed_calls: [] })).success).toBe(false);
    expect(ClaimSchema.safeParse(claim({ needs_human: false })).success).toBe(true);
  });
});

describe("target and line ids", () => {
  it('"lines" needs line ids', () => {
    expect(ClaimSchema.safeParse(claim({ line_ids: [] })).success).toBe(false);
  });
  it.each(["all_lines", "annexure", "invoice_terms"])('"%s" must not list line ids', (target) => {
    expect(ClaimSchema.safeParse(claim({ target, line_ids: ["L1"] })).success).toBe(false);
  });
});

describe("the proposals stay in step with the tool layer", () => {
  const samples = [
    otCall,
    { tool: "remove_line", line_id: "L1", reason: "x" },
    { tool: "defer_line", line_id: "L1", to_period: "2026-11", reason: "x" },
    { tool: "split_invoice", disputed_line_ids: ["L1"] },
    { tool: "set_service_charge_base", value: "wages_only", reason: "the contract says wages only" },
    { tool: "set_field", field: "po_number", value: "MLP/PO/2026/3318", line_id: "L1" },
    { tool: "regroup_lines", group_by: "site_code" },
    { tool: "apply_template" },
  ];

  it.each(samples.map((s) => [s.tool, s] as const))("%s is accepted by both schemas", (_n, s) => {
    expect(ProposedCallSchema.safeParse(s).success).toBe(true);
    expect(ToolCallSchema.safeParse(s).success).toBe(true);
  });

  it("proposes every tool except the reads", () => {
    const proposable = (ProposedCallSchema.options as { shape: { tool: { value: string } } }[]).map((o) => o.shape.tool.value).sort();
    expect(proposable).toEqual(samples.map((s) => s.tool).sort());
  });
});

describe("new rules", () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    type: "format", rule: "Invoices must be dated within the buyer's submission window.",
    quote: "accepts invoices only", claim_ids: [], confidence: "medium",
    check: { kind: "invoice_date_window", from_day: 1, to_day: 5 }, rationale: "Stated as a standing requirement.", ...over,
  });

  it("carries a check from the closed vocabulary", () => {
    expect(RuleProposalSchema.safeParse(rule()).success).toBe(true);
    expect(RuleProposalSchema.safeParse(rule({ check: { kind: "run_shell", cmd: "rm -rf /" } })).success).toBe(false);
    expect(RuleProposalSchema.safeParse(rule({ check: { kind: "manual_review", note: "a person must look" } })).success).toBe(true);
  });

  it("may only cite claims that exist", () => {
    expect(AnalysisSchema.safeParse(analysis({ new_rules: [rule({ claim_ids: ["C1"] })] })).success).toBe(true);
    expect(AnalysisSchema.safeParse(analysis({ new_rules: [rule({ claim_ids: ["C9"] })] })).success).toBe(false);
  });

  it("rejects duplicate claim ids", () => {
    expect(AnalysisSchema.safeParse(analysis({ claims: [claim(), claim()] })).success).toBe(false);
  });
});

describe("verifyQuotes", () => {
  const message = "Dear Madam,\n\n1. OT claimed is 186 hours.   Kindly remove the unauthorised portion.\n\nRegards";
  const a = (quote: string, ruleQuote = "Kindly remove") =>
    AnalysisSchema.parse(analysis({ claims: [claim({ quote })], new_rules: [{
      type: "format", rule: "A rule that is long enough.", quote: ruleQuote, claim_ids: [],
      check: { kind: "manual_review", note: "x" }, confidence: "low", rationale: "x" }] })) as Analysis;

  it("accepts exact spans, ignoring whitespace and case", () => {
    expect(verifyQuotes(a("OT claimed is 186 hours. Kindly remove the unauthorised portion."), message)).toEqual([]);
    expect(verifyQuotes(a("ot claimed IS 186 hours."), message)).toEqual([]);
  });

  it("flags a paraphrase", () => {
    expect(verifyQuotes(a("The overtime is not authorised"), message)).toEqual([
      { where: "C1", quote: "The overtime is not authorised" },
    ]);
  });

  it("flags a rule quote that is not in the message", () => {
    expect(verifyQuotes(a("OT claimed is 186 hours.", "portal window"), message)).toEqual([
      { where: "new_rules[0]", quote: "portal window" },
    ]);
  });
});
