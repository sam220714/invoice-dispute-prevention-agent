import type { Check } from "../schema";

/**
 * Machine-readable checks for every rule in dataset/rule_ledger.json.
 *
 * Hand-authored: at onboarding the ledger was backfilled from history, and the
 * checks went in with it. Rules learned afterwards get their check inferred by
 * the model in the same call that infers the rule.
 *
 * The ledger is split by seed (see data/split.ts): some of these rules go into
 * the agent's context and the rest are held out. A held-out rule's check here is
 * never used, because the rule is not in the ledger the app runs. The model has
 * to infer it from the dispute, and the check it proposes is the one that counts.
 * A test asserts the key set equals the pool's rule ids exactly.
 */
export const RULE_CHECKS: Record<string, Check> = {
  // Meridian
  "MER-R1": { kind: "line_field_required", field: "po_number" },
  "MER-R2": { kind: "lines_grouped_by", field: "site_code" },
  "MER-R3": { kind: "line_field_required", field: "sac" },
  "MER-R4": { kind: "invoice_date_window", from_day: 1, to_day: 5 },
  "MER-R5": {
    kind: "annexure_field_required_when",
    field: "ot_auth_ref",
    when_field: "ot_hours",
    when_gt: 0,
  },
  "MER-R6": { kind: "days_billed_capped_by_last_working_day" },

  // Yogita
  "YOG-R1": {
    kind: "manual_review",
    note: "Man-days must be reconciled to Yogita's plant biometric gate register, which Pragati cannot read.",
  },
  "YOG-R2": { kind: "billing_period_cycle", start_day: 26, end_day: 25 },
  "YOG-R3": {
    kind: "manual_review",
    note: "Overtime above 1.5x needs a written plant-head approval number. The invoice carries no approval field to test.",
  },
  "YOG-R4": { kind: "service_charge_base", expected: "wages_only" },
  "YOG-R5": {
    kind: "manual_review",
    note: "Absences of more than 3 consecutive days are not billable. Daily attendance is not in the invoice data.",
  },
  "YOG-R6": {
    kind: "manual_review",
    note: "The annexure must use Yogita's own Excel template (gate ID, shift). Column layout is not modelled.",
  },

  // Teamlease
  "TEA-R1": {
    kind: "manual_review",
    note: "Uncovered shifts are deducted at Rs 500 each. Shift coverage is not in the invoice data.",
  },
  "TEA-R2": { kind: "payment_terms_days", days: 45 },
  "TEA-R3": {
    kind: "manual_review",
    note: "Festival double-pay needs the store manager's written pre-approval, which is not in the invoice data.",
  },
};
