/**
 * HARNESS, NOT RUNTIME. What a correct model would say about the demo dispute.
 *
 * It is written by hand, not recorded from a model, so the engine's tests (the
 * oracle, the loop, the guards) do not depend on a live API or a prompt. They
 * test what the engine does with a good reply. Whether the model really produces
 * one is a question for the prompt sandbox (npm run try), not for these tests.
 */
import { getBuyer, getInvoice, loadAllDisputes, loadAnnexure, loadDemoDispute, loadSplit } from "../src/lib/data/load";
import { DEMO_SEED } from "../src/lib/data/split";
import { AnalysisSchema, type Analysis } from "../src/lib/engine/analysis_schema";
import type { ContextInput } from "../src/lib/engine/context";
import type { AnalysisMeta } from "../src/lib/engine/llm_call";

export const demoReply: Analysis = AnalysisSchema.parse({
  claims: [
    {
      claim_id: "C1",
      claim: "Overtime at Shamshabad and Patancheru is not authorised; only Medchal's 40 hours are.",
      quote: "Patancheru forklift OT and the Shamshabad housekeeping OT are not authorised",
      bucket: "business",
      target: "lines",
      line_ids: ["L9", "L11"],
      matched_rule_id: "MER-R5",
      match_rationale: "MER-R5 says overtime is payable only against a Meridian authorisation number.",
      proposed_calls: [
        { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "no authorisation for Shamshabad overtime" },
        { tool: "adjust_line", line_id: "L11", field: "qty", value: 0, reason: "no authorisation for Patancheru overtime" },
      ],
      confidence: "high",
    },
    {
      claim_id: "C2",
      claim: "Two Shamshabad loaders who left mid-month were billed for the full month.",
      quote: "Two loaders at Shamshabad have been billed for the full month.",
      bucket: "business",
      target: "lines",
      line_ids: ["L6"],
      matched_rule_id: "MER-R6",
      match_rationale: "MER-R6 limits billing to a worker's last working day.",
      proposed_calls: [
        { tool: "adjust_line", line_id: "L6", field: "qty", value: 520, reason: "Imran billed 12 days over, Rao 8 days over" },
      ],
      confidence: "high",
    },
    {
      claim_id: "C3",
      claim: "The PO number is only in the reference field, not against each line.",
      quote: "The PO number is again given only in the reference field and not against the lines.",
      bucket: "format",
      target: "all_lines",
      line_ids: [],
      matched_rule_id: "MER-R1",
      match_rationale: "MER-R1 requires the PO number against every line item.",
      proposed_calls: [{ tool: "set_field", field: "po_number", value: "MLP/PO/2026/3318" }],
      confidence: "high",
    },
    {
      claim_id: "C4",
      claim: "The SAC code is only in the header, not on every line.",
      quote: "SAC code is shown only in the header. It is required on every line item.",
      bucket: "format",
      target: "all_lines",
      line_ids: [],
      matched_rule_id: "MER-R3",
      match_rationale: "MER-R3 requires SAC 998519 on every line.",
      proposed_calls: [{ tool: "set_field", field: "sac", value: "998519" }],
      confidence: "high",
    },
    {
      claim_id: "C5",
      claim: "The lines are grouped role-wise; Meridian wants them grouped site-wise.",
      quote: "The lines are given role wise. Please group them site wise, as our GL posting is done site wise.",
      bucket: "format",
      target: "all_lines",
      line_ids: [],
      matched_rule_id: null,
      match_rationale: "No active rule asks for site-wise grouping.",
      proposed_calls: [{ tool: "regroup_lines", group_by: "site_code" }],
      confidence: "high",
    },
  ],
  new_rules: [
    {
      type: "format",
      rule: "Lines must be grouped site-wise, not role-wise.",
      quote: "Please group them site wise, as our GL posting is done site wise.",
      claim_ids: ["C5"],
      check: { kind: "lines_grouped_by", field: "site_code" },
      confidence: "medium",
      rationale: "The buyer posts to its GL site by site, so every invoice needs the same grouping.",
    },
    {
      type: "format",
      rule: "Invoices are only accepted on the portal between the 1st and 5th of the month.",
      quote: "Note that our portal accepts invoices only from 1st to 5th of the month.",
      claim_ids: [],
      check: { kind: "invoice_date_window", from_day: 1, to_day: 5 },
      confidence: "medium",
      rationale: "A standing submission window, stated in the closing remark rather than as a numbered objection.",
    },
  ],
  unclear: [],
});

export const stubMeta: AnalysisMeta = {
  model: "hand-written",
  repaired: false,
  attempts: [],
  usage: { input: 0, output: 0, thinking: 0 },
};

/** The demo dispute against the demo split of the ledger. */
export function demoInput(): ContextInput {
  return {
    buyer: getBuyer("BUY-MERIDIAN"),
    invoice: getInvoice("INV-2026-0847"),
    annexure: loadAnnexure("INV-2026-0847"),
    rules: loadSplit(DEMO_SEED).context,
    disputes: loadAllDisputes(),
    message: loadDemoDispute(),
    receivedOn: "2026-10-06",
    systemPrompt: "unused by the engine once a reply exists",
  };
}
