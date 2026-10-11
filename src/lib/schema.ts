import { z } from "zod";

// ------------------------------------------------------------------ buckets
export const BucketSchema = z.enum(["business", "format"]);
export type Bucket = z.infer<typeof BucketSchema>;

export const AutonomySchema = z.enum(["propose_merchant_approves", "auto_apply"]);
export type Autonomy = z.infer<typeof AutonomySchema>;

/** Each bucket routes to a different fix, owner and autonomy level. Encoded once. */
export const BUCKET_AUTONOMY: Record<Bucket, Autonomy> = {
  business: "propose_merchant_approves",
  format: "auto_apply",
};

// ------------------------------------------------------------------ dataset
export const AgencySchema = z.object({
  legal_name: z.string(),
  short_name: z.string(),
  gstin: z.string(),
  headcount_deployed: z.number(),
  active_clients: z.number(),
  monthly_billing_inr: z.number(),
  monthly_gross_margin_inr: z.number(),
  payroll_date: z.number(),
  team: z.array(z.object({ name: z.string(), role: z.string(), does: z.string() })),
});
export type Agency = z.infer<typeof AgencySchema>;

export const ServiceChargeBaseSchema = z.enum(["wages_only", "wages_plus_statutory"]);
export type ServiceChargeBase = z.infer<typeof ServiceChargeBaseSchema>;

export const BuyerSchema = z.object({
  id: z.string(),
  legal_name: z.string(),
  short_name: z.string(),
  archetype: z.string(),
  gstin: z.string(),
  ap_contact: z.string(),
  ap_email: z.string(),
  ap_system: z.string(),
  payment_terms_days: z.number(),
  sites: z.array(z.object({ code: z.string(), name: z.string() })),
  service_charge_pct: z.number(),
  service_charge_base: ServiceChargeBaseSchema,
  billing_cycle: z.string(),
  headcount: z.number(),
  behaviour: z.string(),
});
export type Buyer = z.infer<typeof BuyerSchema>;

export const RateCardSchema = z.object({
  buyer_id: z.string(),
  version: z.string(),
  effective_from: z.string(),
  rates: z.array(z.object({ role: z.string(), unit: z.string(), rate: z.number() })),
});
export type RateCard = z.infer<typeof RateCardSchema>;

export const InvoiceLineSchema = z.object({
  line_id: z.string(),
  description: z.string(),
  site_code: z.string(),
  /** The buyer's PO number, entered at line level. Null until someone fills it in. */
  po_number: z.string().nullable(),
  sac: z.string().nullable(),
  role: z.string(),
  qty: z.number(),
  unit: z.string(),
  rate: z.number(),
  amount: z.number(),
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

export const TotalsSchema = z.object({
  wages: z.number(),
  pf_employer: z.number(),
  esi_employer: z.number(),
  service_charge: z.number(),
  service_charge_pct: z.number(),
  service_charge_base: ServiceChargeBaseSchema,
  service_charge_basis_amount: z.number(),
  taxable_value: z.number(),
  cgst: z.number(),
  sgst: z.number(),
  grand_total: z.number(),
});
export type Totals = z.infer<typeof TotalsSchema>;

export const InvoiceSchema = z.object({
  invoice_id: z.string(),
  buyer_id: z.string(),
  buyer_name: z.string(),
  buyer_gstin: z.string(),
  period_label: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  invoice_date: z.string(),
  due_date: z.string(),
  sac: z.string(),
  /** The PO number on the invoice header. Some buyers also want it on every line. */
  po_number: z.string(),
  lines: z.array(InvoiceLineSchema),
  totals: TotalsSchema,
  status: z.string(),
  notes: z.string(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const AnnexureRowSchema = z.object({
  emp_name: z.string(),
  role: z.string(),
  site: z.string(),
  days_billed: z.number(),
  last_working_day: z.string().nullable(),
  ot_hours: z.number(),
  ot_auth_ref: z.string().nullable(),
});
export type AnnexureRow = z.infer<typeof AnnexureRowSchema>;

export const AnnexureSchema = z.object({
  invoice_id: z.string(),
  buyer_id: z.string(),
  note: z.string(),
  rows: z.array(AnnexureRowSchema),
  /** The authoritative overtime ledger: totals, and billed against authorised hours per site. */
  ot_summary: z
    .object({
      total_billed_hours: z.number(),
      hours_with_authorisation: z.number(),
      hours_without_authorisation: z.number(),
      authorisation_refs_present: z.array(z.string()),
      by_site: z.record(z.object({ billed_hours: z.number(), authorised_hours: z.number() })),
    })
    .optional(),
});
export type Annexure = z.infer<typeof AnnexureSchema>;

export const DisputeSchema = z.object({
  dispute_id: z.string(),
  buyer_id: z.string(),
  invoice_id: z.string(),
  received_at: z.string(),
  channel: z.string(),
  detected_how: z.string(),
  raw_text: z.string(),
  buckets: z.array(BucketSchema),
  resolution: z.string(),
  days_delayed: z.number().nullable(),
  amount_disputed: z.number(),
});
export type Dispute = z.infer<typeof DisputeSchema>;

// ------------------------------------------------------------------ checks
// The closed vocabulary a ledger rule can be enforced with. The LLM infers a
// rule's `check` from a messy email; runChecks() enforces it as a plain linter.
// A model-authored check outside this union fails validation and is discarded.
const LineFieldSchema = z.enum(["po_number", "sac", "description"]);

export const CheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line_field_required"), field: LineFieldSchema }),
  z.object({
    kind: z.literal("line_field_matches"),
    field: LineFieldSchema,
    pattern: z.string(),
  }),
  z.object({ kind: z.literal("lines_grouped_by"), field: z.literal("site_code") }),
  z.object({
    kind: z.literal("annexure_field_required_when"),
    field: z.literal("ot_auth_ref"),
    when_field: z.literal("ot_hours"),
    when_gt: z.number(),
  }),
  z.object({ kind: z.literal("days_billed_capped_by_last_working_day") }),
  z.object({
    kind: z.literal("invoice_date_window"),
    from_day: z.number().int(),
    to_day: z.number().int(),
  }),
  z.object({ kind: z.literal("service_charge_base"), expected: ServiceChargeBaseSchema }),
  z.object({
    kind: z.literal("billing_period_cycle"),
    start_day: z.number().int(),
    end_day: z.number().int(),
  }),
  z.object({ kind: z.literal("payment_terms_days"), days: z.number().int() }),
  /** A rule the linter cannot mechanise surfaces for a human instead of vanishing. */
  z.object({ kind: z.literal("manual_review"), note: z.string() }),
]);
export type Check = z.infer<typeof CheckSchema>;

// ------------------------------------------------------------------ ledger
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const RuleSchema = z.object({
  rule_id: z.string(),
  buyer_id: z.string(),
  type: BucketSchema,
  rule: z.string(),
  confidence: ConfidenceSchema,
  learned_from: z.array(z.string()),
  status: z.enum(["active", "disabled"]),
  times_corroborated: z.number().int(),
  check: CheckSchema.optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

// ---------------------------------------------------------------- findings
export type FactValue = string | number | string[];

export interface Finding {
  rule_id: string;
  bucket: Bucket;
  autonomy: Autonomy;
  message: string;
  /** Empty for invoice-level findings. */
  line_ids: string[];
  /** Quantities and names only. Money is produced solely by recomputeInvoice(). */
  facts: Record<string, FactValue>;
}

export type CheckOutcome = "pass" | "fail" | "manual";

export interface CheckResult {
  rule_id: string;
  bucket: Bucket;
  rule_text: string;
  outcome: CheckOutcome;
  /** Present when outcome is "fail". */
  finding?: Finding;
  /** Present when outcome is "manual": why the linter could not decide. */
  note?: string;
}

// --------------------------------------------------------------- overrides
/**
 * The merchant looked at a flagged finding and decided it is fine for this invoice, because of something
 * the ledger does not know. Only business and manual-review findings can be overridden; format fixes cannot.
 */
export const OverrideSchema = z.object({
  /** One override per invoice and rule: overriding again replaces it. */
  invoice_id: z.string(),
  buyer_id: z.string(),
  rule_id: z.string(),
  bucket: BucketSchema,
  kind: z.enum(["finding", "manual_review"]),
  /**
   * Identifies the finding that was overridden (rule, lines, message). If the invoice changes so the
   * finding changes, the override no longer matches and the finding comes back for another look.
   */
  fingerprint: z.string(),
  /** The finding as the merchant saw it, so the audit trail reads without the invoice. */
  summary: z.string(),
  reason: z.string().nullable(),
  by: z.string().nullable(),
  at: z.string(),
});
export type Override = z.infer<typeof OverrideSchema>;
