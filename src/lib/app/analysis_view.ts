import { getBuyer, getInvoice, loadAllDisputes, loadInvoices } from "../data/load";
import type { AnalysisResult, ClaimOutcome } from "../engine/analyze";
import { applyToolCall, type Draft, type ToolCall } from "../engine/tools";
import type { Invoice } from "../schema";
import { compactLines, shortDate } from "./format";
import { displayCall, siteLabels, type DisplayCall, type Source, type TotalsView } from "./presend_view";
import { segmentMessage, type Segment } from "./quotes";
import { loadAnalysis, type ResolvedRecord } from "./store";

/**
 * The dispute-analysis screen as data. The stored analysis is the model's reading of the message plus
 * everything the engine did with it; this file turns that into what the screen shows and, for the
 * merchant's decisions, asks the engine what each choice would do to the invoice.
 */

// ------------------------------------------------------------------- shapes
export interface EditableQty {
  /** `${claim_id}:${line_id}`, the key the merchant's edit is stored under. */
  key: string;
  line_id: string;
  label: string;
  unit: string;
  current: number;
  proposed: number;
}

export interface ClaimView {
  claim_id: string;
  bucket: "business" | "format";
  status: ClaimOutcome["status"];
  title: string;
  where: string;
  line_ids: string[];
  all_lines: boolean;
  seen: "foreseeable" | "new" | null;
  /** What approving this one claim takes off the invoice, from the engine. */
  amount: number | null;
  calls: DisplayCall[];
  edits: EditableQty[];
  foresight: { rule_id: string; rule: string; sources: Source[] } | null;
  rationale: string;
  checks: { line_id: string; verdict: string; basis: string }[];
  notes: string[];
  needs_human: boolean;
  rule_ix: number | null;
}

export interface RuleView {
  ix: number;
  type: "business" | "format";
  text: string;
  quote: string;
  confidence: string;
  claim_ids: string[];
  /** An active rule already enforces this: seeing it again only corroborates. */
  duplicate_of: string | null;
}

export interface LineRow {
  line_id: string;
  description: string;
  site_name: string;
  site_full: string;
  unit: string;
  qty: number;
  amount: number;
}

export interface Preview {
  original_total: number;
  revised_total: number;
  total_reduction: number;
  wage_reduction: number;
  per_claim: Record<string, number>;
  lines: Record<string, { qty: number; amount: number }>;
  totals: TotalsView;
}

export interface ResolvedView {
  dispute_id: string;
  at: string;
  approved: string[];
  declined: { claim_id: string; reason: string | null }[];
  /** Keys of the quantities the merchant changed before approving. */
  edited: string[];
  written: { rule_id: string; text: string; type: string; sources: string[] }[];
  corroborated: { rule_id: string; text: string; times_after: number; confidence_after: string; confidence_before: string }[];
  skipped_rules: number;
  revised_total: number;
  total_reduction: number;
  ledger_size: number;
  /** The same buyer's draft, which the pre-send check now reads with the new ledger. */
  next_draft: { invoice_id: string; period_label: string } | null;
}

export interface AnalysisView {
  invoice_id: string;
  buyer_short: string;
  received_on: string;
  message: string;
  segments: Segment[];
  claims: ClaimView[];
  rules: RuleView[];
  unclear: string[];
  foreseen: { matched: number; total: number };
  lines: LineRow[];
  grouped_by_site: boolean;
  base_totals: TotalsView;
  preview: Preview;
  context: { name: string; items: number; detail: string }[];
  context_tokens: number;
  model: string;
  resolved: ResolvedView | null;
}

// ---------------------------------------------------------------- previews
const clampQty = (value: number, current: number) => Math.max(0, Math.min(current, Number.isFinite(value) ? value : current));

/** The staged business proposals with the merchant's quantity edits applied. */
export function stagedWithEdits(result: AnalysisResult, edits: Record<string, number>): AnalysisResult["staged"] {
  return result.staged.map((s) => ({
    claim_id: s.claim_id,
    calls: s.calls.map((c): ToolCall => {
      if (c.tool !== "adjust_line") return c;
      const edited = edits[`${s.claim_id}:${c.line_id}`];
      const line = result.draft.invoice.lines.find((l) => l.line_id === c.line_id);
      return edited === undefined || !line ? c : { ...c, value: clampQty(edited, line.qty) };
    }),
  }));
}

const totalsOf = (inv: Invoice): TotalsView => ({
  wages: inv.totals.wages,
  statutory: inv.totals.pf_employer + inv.totals.esi_employer + inv.totals.service_charge,
  gst: inv.totals.cgst + inv.totals.sgst,
  total: inv.totals.grand_total,
});

function applyAll(draft: Draft, calls: ToolCall[]): Draft {
  let d = draft;
  for (const call of calls) d = applyToolCall(d, call, { actor: "merchant" }).draft;
  return d;
}

/** What the invoice looks like if exactly these claims are approved, with these quantities. All money from the engine. */
export function computePreview(result: AnalysisResult, include: string[], edits: Record<string, number>): Preview {
  const staged = stagedWithEdits(result, edits);
  const chosen = staged.filter((s) => include.includes(s.claim_id));
  const before = result.draft.invoice;
  const after = applyAll(result.draft, chosen.flatMap((s) => s.calls)).invoice;

  const per_claim: Record<string, number> = {};
  for (const s of staged) {
    per_claim[s.claim_id] = before.totals.grand_total - applyAll(result.draft, s.calls).invoice.totals.grand_total;
  }
  const lines: Preview["lines"] = {};
  for (const l of after.lines) lines[l.line_id] = { qty: l.qty, amount: l.amount };

  return {
    original_total: before.totals.grand_total,
    revised_total: after.totals.grand_total,
    total_reduction: before.totals.grand_total - after.totals.grand_total,
    wage_reduction: before.totals.wages - after.totals.wages,
    per_claim: Object.fromEntries(Object.entries(per_claim).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    lines,
    totals: totalsOf(after),
  };
}

// -------------------------------------------------------------------- build
function whereOf(o: ClaimOutcome, invoice: Invoice): string {
  const c = o.claim;
  if (c.target === "all_lines") return `all ${invoice.lines.length} lines`;
  if (c.target === "annexure") return "annexure";
  if (c.target === "invoice_terms") return "invoice terms";

  const ids = compactLines(c.line_ids);
  const cuts = o.quantity_checks.filter((q) => q.verdict !== "rejected" && q.final_qty < q.current_qty);
  const units = new Set(cuts.map((q) => invoice.lines.find((l) => l.line_id === q.line_id)?.unit));
  if (cuts.length && units.size === 1) {
    const removed = cuts.reduce((s, q) => s + (q.current_qty - q.final_qty), 0);
    return `${ids} · ${removed} ${[...units][0]}`;
  }
  return ids;
}

function noteFor(o: ClaimOutcome): string[] {
  const notes: string[] = [];
  if (o.status === "needs_human") notes.push("The invoice data cannot settle this, so no fix was proposed. A person has to look.");
  if (o.status === "rejected") notes.push(...o.steps.filter((s) => s.status === "rejected").map((s) => s.message));
  if (o.status === "partial") notes.push(...o.unresolved.map((u) => u.reason));
  return notes;
}

export function buildAnalysisView(invoiceId: string): AnalysisView | null {
  const stored = loadAnalysis(invoiceId);
  if (!stored) return null;
  const { result } = stored;
  const invoice = getInvoice(invoiceId);
  const buyer = getBuyer(invoice.buyer_id);
  const disputeDates = new Map(loadAllDisputes().map((d) => [d.dispute_id, d.received_at]));
  const sourcesOf = (ids: string[]): Source[] => ids.map((id) => ({ id, date: disputeDates.has(id) ? shortDate(disputeDates.get(id)!) : null }));

  const rules: RuleView[] = result.proposed_rules.map((p, ix) => ({
    ix, type: p.proposal.type, text: p.proposal.rule, quote: p.proposal.quote, confidence: p.proposal.confidence,
    claim_ids: p.proposal.claim_ids, duplicate_of: p.duplicate_of,
  }));
  const taughtBy = (claimId: string) => rules.find((r) => !r.duplicate_of && r.claim_ids.includes(claimId))?.ix ?? null;

  const stagedIds = new Set(result.staged.map((s) => s.claim_id));
  const claims: ClaimView[] = result.outcomes.map((o) => {
    const c = o.claim;
    const ruleIx = taughtBy(c.claim_id);
    const edits: EditableQty[] = o.calls.flatMap((call) => {
      if (call.tool !== "adjust_line" || !stagedIds.has(c.claim_id)) return [];
      const line = result.draft.invoice.lines.find((l) => l.line_id === call.line_id);
      return line
        ? [{ key: `${c.claim_id}:${line.line_id}`, line_id: line.line_id, label: line.description.replace(/ - .*$/, ""), unit: line.unit, current: line.qty, proposed: call.value }]
        : [];
    });
    return {
      claim_id: c.claim_id,
      bucket: c.bucket,
      status: o.status,
      title: c.claim,
      where: whereOf(o, invoice),
      line_ids: c.line_ids,
      all_lines: c.target === "all_lines",
      seen: o.foresight ? "foreseeable" : ruleIx !== null ? "new" : null,
      amount: o.impact ? o.impact.total_reduction_inr : null,
      calls: o.calls.map(displayCall),
      edits,
      foresight: o.foresight ? { rule_id: o.foresight.rule_id, rule: o.foresight.rule, sources: sourcesOf(o.foresight.learned_from) } : null,
      rationale: c.match_rationale,
      checks: o.quantity_checks.map((q) => ({ line_id: q.line_id, verdict: q.verdict, basis: q.basis })),
      notes: noteFor(o),
      needs_human: Boolean(c.needs_human),
      rule_ix: ruleIx,
    };
  });

  const spans = [
    ...result.outcomes.map((o) => ({ key: o.claim.claim_id, quote: o.claim.quote })),
    ...rules.filter((r) => !r.duplicate_of).map((r) => ({ key: `rule:${r.ix}`, quote: r.quote })),
  ];

  // Emails are hard-wrapped; join the continuation lines so a highlighted claim reads as one run of words.
  const display = result.context.message.replace(/\r\n?/g, "\n").replace(/\n[ \t]+(?=\S)/g, " ");

  const base = result.draft.invoice;
  const label = siteLabels(buyer.sites);
  const seen = new Set<string>();
  let previous: string | null = null;
  let grouped = true;
  for (const l of base.lines) {
    if (l.site_code !== previous && seen.has(l.site_code)) grouped = false;
    seen.add(l.site_code);
    previous = l.site_code;
  }

  let resolved: ResolvedView | null = null;
  if (stored.resolved) {
    const r: ResolvedRecord = stored.resolved;
    const nextDraft = loadInvoices().find((i) => i.buyer_id === invoice.buyer_id && i.status === "draft") ?? null;
    resolved = {
      dispute_id: r.dispute_id,
      at: r.at,
      approved: r.approved,
      declined: r.declined,
      edited: Object.keys(r.edited_qty),
      written: r.written.map((w) => ({ rule_id: w.rule_id, text: w.rule, type: w.type, sources: w.learned_from })),
      corroborated: r.corroborated.map((c) => ({
        rule_id: c.rule_id, text: result.outcomes.find((o) => o.foresight?.rule_id === c.rule_id)?.foresight?.rule ?? "",
        times_after: c.times_after, confidence_after: c.confidence_after, confidence_before: c.confidence_before,
      })),
      skipped_rules: r.skipped_rules.length,
      revised_total: r.revised_total,
      total_reduction: r.total_reduction,
      ledger_size: r.ledger_size,
      next_draft: nextDraft ? { invoice_id: nextDraft.invoice_id, period_label: nextDraft.period_label } : null,
    };
  }

  const stagedAll = result.staged.map((s) => s.claim_id);
  return {
    invoice_id: invoiceId,
    buyer_short: buyer.short_name,
    received_on: result.received_on,
    message: display,
    segments: segmentMessage(display, spans),
    claims,
    rules,
    unclear: result.unclear,
    foreseen: { matched: result.foreseen.matched, total: result.foreseen.total },
    lines: base.lines.map((l) => ({
      line_id: l.line_id, description: l.description.replace(/ - .*$/, ""), site_name: label.short(l.site_code), site_full: label.full(l.site_code),
      unit: l.unit, qty: l.qty, amount: l.amount,
    })),
    grouped_by_site: grouped,
    base_totals: totalsOf(base),
    preview: computePreview(result, resolved ? (stored.resolved?.approved ?? []) : stagedAll, stored.resolved?.edited_qty ?? {}),
    context: result.context.sections.map((s) => ({ name: s.name, items: s.items, detail: s.detail })),
    context_tokens: result.context.est_tokens,
    model: result.meta.model,
    resolved,
  };
}

