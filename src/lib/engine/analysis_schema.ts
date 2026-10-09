import { z } from "zod";
import { BucketSchema, CheckSchema, ConfidenceSchema, ServiceChargeBaseSchema } from "../schema";
import { LineId, Period, Reason, TOOL_KIND } from "./tools";

/**
 * What the one LLM call returns. Read this as the contract between the model and
 * the engine.
 *
 *  - There is no money field anywhere. A claim carries quantities and tool-call
 *    intents; every rupee comes later from recomputeInvoice().
 *  - `quote` must be a verbatim span of the buyer's message, so a hallucinated
 *    claim can be caught by plain string search (see verifyQuotes).
 *  - A claim's proposed tools must match its bucket, so a misclassification
 *    fails validation instead of reaching the merchant.
 */

// What a model may propose. Reads are not proposals.
export const ProposedCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("adjust_line"), line_id: LineId, field: z.literal("qty"), value: z.number().finite().nonnegative(), reason: Reason }).strict(),
  z.object({ tool: z.literal("remove_line"), line_id: LineId, reason: Reason }).strict(),
  z.object({ tool: z.literal("defer_line"), line_id: LineId, to_period: Period, reason: Reason }).strict(),
  z.object({ tool: z.literal("split_invoice"), disputed_line_ids: z.array(LineId).min(1) }).strict(),
  z.object({ tool: z.literal("set_service_charge_base"), value: ServiceChargeBaseSchema, reason: Reason }).strict(),
  z.object({
    tool: z.literal("set_field"),
    field: z.enum(["po_number", "sac"]),
    value: z.string().trim().min(1).max(100),
    line_id: LineId.optional(),
  }).strict(),
  z.object({ tool: z.literal("regroup_lines"), group_by: z.literal("site_code") }).strict(),
  z.object({ tool: z.literal("apply_template") }).strict(),
]);
export type ProposedCall = z.infer<typeof ProposedCallSchema>;

export const TargetSchema = z.enum(["lines", "all_lines", "annexure", "invoice_terms"]);

export const ClaimSchema = z
  .object({
    claim_id: z.string().regex(/^C\d+$/, "expected C1, C2, ..."),
    /** Plain-English statement of what the buyer says is wrong. */
    claim: z.string().trim().min(1).max(400),
    /** Verbatim span of the message that supports the claim. */
    quote: z.string().trim().min(1).max(600),
    bucket: BucketSchema,
    target: TargetSchema,
    /** Invoice line ids affected. Non-empty exactly when target is "lines". */
    line_ids: z.array(LineId),
    /** The active ledger rule that already covers this, or null. */
    matched_rule_id: z.string().nullable(),
    match_rationale: z.string().trim().min(1).max(400),
    /** Empty exactly when `needs_human` is true. */
    proposed_calls: z.array(ProposedCallSchema),
    /**
     * The buyer's objection is real and may match a rule, but the tools cannot act on it with the
     * data in hand. It stays a claim, so the merchant still hears it was foreseeable.
     */
    needs_human: z.boolean().optional(),
    confidence: ConfidenceSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (c.target === "lines" && c.line_ids.length === 0) issue('target "lines" needs at least one line_id', ["line_ids"]);
    if (c.target !== "lines" && c.line_ids.length > 0) issue(`line_ids must be empty when target is "${c.target}"`, ["line_ids"]);
    if (c.needs_human && c.proposed_calls.length > 0) issue("a needs_human claim carries no proposed calls", ["proposed_calls"]);
    if (!c.needs_human && c.proposed_calls.length === 0)
      issue("a claim needs at least one proposed call, or needs_human set to true", ["proposed_calls"]);

    c.proposed_calls.forEach((call, i) => {
      const kind = TOOL_KIND[call.tool];
      const ok = kind === c.bucket;
      if (!ok) issue(`${call.tool} is a ${kind} tool, so it cannot fix a ${c.bucket} claim`, ["proposed_calls", i, "tool"]);
    });
  });
export type Claim = z.infer<typeof ClaimSchema>;

export const RuleProposalSchema = z
  .object({
    type: BucketSchema,
    /** The standing requirement, in plain English, as it would sit in the ledger. */
    rule: z.string().trim().min(10).max(300),
    quote: z.string().trim().min(1).max(600),
    /** Claims that taught this rule; empty when it came from an incidental remark. */
    claim_ids: z.array(z.string().regex(/^C\d+$/)),
    /** How the linter will enforce it, from the closed vocabulary. */
    check: CheckSchema,
    confidence: ConfidenceSchema,
    rationale: z.string().trim().min(1).max(400),
  })
  .strict();
export type RuleProposal = z.infer<typeof RuleProposalSchema>;

export const AnalysisSchema = z
  .object({
    claims: z.array(ClaimSchema),
    new_rules: z.array(RuleProposalSchema),
    /** Spans of the message the model could not confidently classify. */
    unclear: z.array(z.string()),
  })
  .strict()
  .superRefine((a, ctx) => {
    const ids = a.claims.map((c) => c.claim_id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate claim_id ${id}`, path: ["claims", i, "claim_id"] });
    });
    a.new_rules.forEach((r, i) =>
      r.claim_ids.forEach((id) => {
        if (!ids.includes(id))
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `refers to unknown claim ${id}`, path: ["new_rules", i, "claim_ids"] });
      }),
    );
  });
export type Analysis = z.infer<typeof AnalysisSchema>;

// -------------------------------------------------------------- verification
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Quotes that do not appear in the message. Whitespace and case are ignored, nothing else. */
export function verifyQuotes(analysis: Analysis, message: string): { where: string; quote: string }[] {
  const haystack = squash(message);
  const bad: { where: string; quote: string }[] = [];
  for (const c of analysis.claims) if (!haystack.includes(squash(c.quote))) bad.push({ where: c.claim_id, quote: c.quote });
  analysis.new_rules.forEach((r, i) => {
    if (!haystack.includes(squash(r.quote))) bad.push({ where: `new_rules[${i}]`, quote: r.quote });
  });
  return bad;
}
