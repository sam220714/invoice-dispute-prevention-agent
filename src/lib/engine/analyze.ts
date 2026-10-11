import type { Annexure, Autonomy, Invoice, InvoiceLine } from "../schema";
import { BUCKET_AUTONOMY } from "../schema";
import type { LlmProvider } from "../llm/provider";
import type { Claim, ProposedCall, RuleProposal } from "./analysis_schema";
import { type TotalsDelta } from "./arithmetic";
import { runChecks } from "./checks";
import { assembleContext, type AgentContext, type ContextInput } from "./context";
import { checkMessage, type NotReady } from "./input_check";
import { runAnalysis, type AnalysisMeta } from "./llm_call";
import { buildPreSendReport, type PreSendReport } from "./presend";
import { applyToolCall, createDraft, previewImpact, type Draft, type ToolCall, type ToolResult } from "./tools";

/**
 * The orchestrator. One model call proposes; this file decides what happens.
 *
 *   context -> model -> check every quantity against the evidence ->
 *   execute by bucket -> recompute the invoice -> match claims to the ledger
 *
 * The model is trusted to read an email, not to do sums. Wherever the evidence
 * in the annexure fixes a quantity, the engine's figure replaces the model's and
 * the disagreement is reported rather than hidden. Every rupee in the result
 * comes from recomputeInvoice().
 */

// ------------------------------------------------------------------- result
export type Verdict = "verified" | "corrected" | "unverified" | "rejected";

/** One quantity the model proposed, checked against what the annexure supports. */
export interface QuantityCheck {
  claim_id: string;
  line_id: string;
  current_qty: number;
  model_qty: number;
  /** What the evidence supports, or null when the annexure cannot settle it. */
  engine_qty: number | null;
  /** The quantity the engine will use. */
  final_qty: number;
  verdict: Verdict;
  basis: string;
}

export interface Step {
  tool: string;
  status: ToolResult["status"];
  message: string;
}

export type ClaimStatus =
  | "applied" //   format: fixed and verified by the linter
  | "partial" //   format: fixed in part; a person must finish
  | "proposed" //  business: waiting for the merchant
  | "needs_human" // a real claim the tools cannot act on; no fix was proposed
  | "rejected"; // the engine refused the proposal

export interface Foresight {
  rule_id: string;
  rule: string;
  learned_from: string[];
  /** The linter, run on the invoice as sent, would have flagged this. */
  linter_flagged: boolean;
}

export interface ClaimOutcome {
  claim: Claim;
  autonomy: Autonomy;
  status: ClaimStatus;
  /** The calls actually executed or staged, after quantity corrections. */
  calls: ToolCall[];
  steps: Step[];
  quantity_checks: QuantityCheck[];
  /** Business claims: what approving this one claim alone would do to the invoice. */
  impact: TotalsDelta | null;
  /** Set when an active rule already covered this claim. */
  foresight: Foresight | null;
  /** Format claims: what the template could not do. */
  unresolved: { rule_id: string; line_ids: string[]; reason: string }[];
}

export interface ProposedRule {
  proposal: RuleProposal;
  /** An active rule that already enforces the same thing. Then this is corroboration, not news. */
  duplicate_of: string | null;
}

export interface AnalysisResult {
  invoice_id: string;
  buyer_id: string;
  received_on: string;
  context: AgentContext["snapshot"];
  meta: AnalysisMeta;
  outcomes: ClaimOutcome[];
  proposed_rules: ProposedRule[];
  unclear: string[];
  /** The draft after format fixes. Business proposals are NOT applied to it. */
  draft: Draft;
  /** Business proposals in claim order, ready for the merchant to approve. */
  staged: { claim_id: string; calls: ToolCall[] }[];
  money: {
    original_total_inr: number;
    revised_total_inr: number;
    wage_reduction_inr: number;
    total_reduction_inr: number;
    /** Revised total if every business proposal is approved; the rest need not wait. */
    collectable_now_inr: number;
  };
  /** The pre-send report on the draft once the automatic fixes have run. */
  after_fixes: PreSendReport;
  foreseen: { matched: number; total: number; rule_ids: string[]; source_disputes: string[] };
}

// ------------------------------------------------------- evidence arithmetic
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86_400_000);

/**
 * The quantity the annexure supports for a line, or null when it cannot say.
 * Overtime is capped at the authorised hours; man-days lose the days billed
 * beyond each exited worker's last working day.
 */
export function supportedQuantity(
  line: InvoiceLine,
  invoice: Invoice,
  annexure: Annexure | null,
): { qty: number; basis: string } | null {
  if (!annexure) return null;

  if (line.unit === "hours") {
    const site = annexure.ot_summary?.by_site[line.site_code];
    if (!site) return null;
    return {
      qty: Math.min(line.qty, site.authorised_hours),
      basis: `${site.authorised_hours} of ${site.billed_hours} overtime hours at ${line.site_code} carry an authorisation reference`,
    };
  }

  const excess = annexure.rows
    .filter((r) => r.last_working_day !== null && r.role === line.role && r.site === line.site_code)
    .map((r) => ({ row: r, over: r.days_billed - Math.max(0, daysBetween(invoice.period_start, r.last_working_day!) + 1) }))
    .filter((x) => x.over > 0);
  if (!excess.length) return null;
  const total = excess.reduce((s, x) => s + x.over, 0);
  return {
    qty: line.qty - total,
    basis: excess.map((x) => `${x.row.emp_name} ${x.over}d over (last day ${x.row.last_working_day})`).join("; "),
  };
}

// ------------------------------------------------------------------ helpers
const step = (tool: string, r: ToolResult): Step => ({
  tool,
  status: r.status,
  message: r.ok ? r.message : r.error,
});

const sameCheck = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkQuantities(claim: Claim, draft: Draft, calls: ProposedCall[]): { calls: ProposedCall[]; checks: QuantityCheck[] } {
  const checks: QuantityCheck[] = [];
  const out = calls.map((call): ProposedCall => {
    if (call.tool !== "adjust_line") return call;
    const line = draft.invoice.lines.find((l) => l.line_id === call.line_id);
    if (!line) return call; // applyToolCall will reject it with a proper message

    const base = { claim_id: claim.claim_id, line_id: line.line_id, current_qty: line.qty, model_qty: call.value };
    const supported = supportedQuantity(line, draft.baseline, draft.annexure);

    if (call.value > line.qty) {
      checks.push({ ...base, engine_qty: supported?.qty ?? null, final_qty: line.qty, verdict: "rejected",
        basis: `a dispute cannot raise ${line.line_id} from ${line.qty} to ${call.value}` });
      return call;
    }
    if (!supported) {
      checks.push({ ...base, engine_qty: null, final_qty: call.value, verdict: "unverified",
        basis: "the annexure does not settle this quantity; the model's figure stands until the merchant checks it" });
      return call;
    }
    if (supported.qty === call.value) {
      checks.push({ ...base, engine_qty: supported.qty, final_qty: call.value, verdict: "verified", basis: supported.basis });
      return call;
    }
    checks.push({ ...base, engine_qty: supported.qty, final_qty: supported.qty, verdict: "corrected",
      basis: `${supported.basis}; the model proposed ${call.value}, the annexure supports ${supported.qty}` });
    return { ...call, value: supported.qty, reason: `${call.reason} [engine: corrected ${call.value} to ${supported.qty} from the annexure]` };
  });
  return { calls: out, checks };
}

// --------------------------------------------------------------------- core
/** Everything after the model call. Deterministic: same analysis in, same result out. */
export function processAnalysis(
  input: ContextInput,
  ctx: AgentContext,
  analysis: { claims: Claim[]; new_rules: RuleProposal[]; unclear: string[] },
  meta: AnalysisMeta,
): AnalysisResult {
  const { invoice, buyer, annexure } = input;
  const rules = input.rules.filter((r) => r.buyer_id === buyer.id);
  const active = rules.filter((r) => r.status === "active");
  const ruleById = new Map(active.map((r) => [r.rule_id, r]));

  const asSent = runChecks({ invoice, buyer, annexure }, rules);
  const flaggedAsSent = new Set(asSent.filter((r) => r.outcome === "fail").map((r) => r.rule_id));

  let draft = createDraft({ invoice, buyer, annexure, rules });
  const outcomes: ClaimOutcome[] = [];

  for (const claim of analysis.claims) {
    const autonomy = BUCKET_AUTONOMY[claim.bucket];
    const matched = claim.matched_rule_id ? ruleById.get(claim.matched_rule_id) : undefined;
    const foresight: Foresight | null = matched
      ? { rule_id: matched.rule_id, rule: matched.rule, learned_from: matched.learned_from, linter_flagged: flaggedAsSent.has(matched.rule_id) }
      : null;

    const { calls: proposed, checks } = checkQuantities(claim, draft, claim.proposed_calls);
    const calls: ToolCall[] = proposed;
    const out: ClaimOutcome = {
      claim, autonomy, status: "proposed", calls, steps: [], quantity_checks: checks,
      impact: null, foresight, unresolved: [],
    };

    if (claim.needs_human) {
      // Nothing to execute. The claim, and any rule it matched, still count: it was foreseeable.
      out.status = "needs_human";
    } else if (claim.bucket === "business") {
      // Staged, never applied. Preview on a throwaway copy so the money is real.
      const refused = checks.some((c) => c.verdict === "rejected");
      const preview = previewImpact(draft, refused ? [] : calls);
      out.steps = preview.results.map((r, i) => step(calls[i]!.tool, r));
      out.impact = refused ? null : preview.delta;
      out.status = refused || preview.results.some((r) => !r.ok) ? "rejected" : "proposed";
      if (refused) out.steps = checks.filter((c) => c.verdict === "rejected").map((c) => ({ tool: "adjust_line", status: "rejected", message: c.basis }));
    } else {
      for (const call of calls) {
        const r = applyToolCall(draft, call, { actor: "engine" });
        draft = r.draft;
        out.steps.push(step(call.tool, r.result));
        const unresolved = r.result.ok ? (r.result.data as { unresolved?: ClaimOutcome["unresolved"] } | undefined)?.unresolved : undefined;
        if (unresolved) out.unresolved.push(...unresolved);
      }
      const failed = out.steps.some((s) => s.status === "rejected");
      out.status = failed ? "rejected" : out.unresolved.length ? "partial" : "applied";
    }
    outcomes.push(out);
  }

  // Business proposals together: the number the merchant is actually being asked to approve.
  const staged = outcomes
    .filter((o) => o.claim.bucket === "business" && o.status === "proposed")
    .map((o) => ({ claim_id: o.claim.claim_id, calls: o.calls }));
  const combined = previewImpact(draft, staged.flatMap((s) => s.calls));
  const delta = combined.delta;

  const proposed_rules: ProposedRule[] = analysis.new_rules.map((proposal) => ({
    proposal,
    duplicate_of: active.find((r) => r.check && sameCheck(r.check, proposal.check))?.rule_id ?? null,
  }));

  const matchedClaims = outcomes.filter((o) => o.foresight);
  const sources = new Set(matchedClaims.flatMap((o) => o.foresight!.learned_from));

  return {
    invoice_id: invoice.invoice_id,
    buyer_id: buyer.id,
    received_on: input.receivedOn,
    context: ctx.snapshot,
    meta,
    outcomes,
    proposed_rules,
    unclear: analysis.unclear,
    draft,
    staged,
    money: {
      original_total_inr: delta.original_total_inr,
      revised_total_inr: delta.revised_total_inr,
      wage_reduction_inr: delta.wage_reduction_inr,
      total_reduction_inr: delta.total_reduction_inr,
      collectable_now_inr: delta.revised_total_inr,
    },
    after_fixes: buildPreSendReport({ invoice: draft.invoice, buyer, annexure: draft.annexure }, rules),
    foreseen: {
      matched: matchedClaims.length,
      total: outcomes.length,
      rule_ids: [...new Set(matchedClaims.map((o) => o.foresight!.rule_id))].sort(),
      source_disputes: [...sources].sort(),
    },
  };
}

/** The pasted message is not ready to analyse. Nothing has been sent to the model. */
export class MessageNotReady extends Error {
  constructor(readonly verdict: NotReady) {
    super(verdict.message);
    this.name = "MessageNotReady";
  }
}

export interface AnalyzeOptions {
  /** The person has seen the "looks cut off" warning and wants to go ahead. Never overrides a blocked message. */
  proceedAnyway?: boolean;
}

export async function analyzeDispute(input: ContextInput, provider: LlmProvider, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  // Before any model call: a message that is empty, huge, or looks cut off costs nothing to refuse.
  const verdict = checkMessage(input.message);
  if (verdict.status === "blocked" || (verdict.status === "maybe_cut_off" && !opts.proceedAnyway)) throw new MessageNotReady(verdict);
  const ctx = assembleContext(input);
  const { analysis, meta } = await runAnalysis(ctx, provider);
  return processAnalysis(input, ctx, analysis, meta);
}

