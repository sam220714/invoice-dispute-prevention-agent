"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  loadAllDisputes, loadLedger, loadOverrides, recordOutcome, resetState, saveLedger, saveOverrides,
} from "../lib/data/load";
import { compareInvoices } from "../lib/engine/arithmetic";
import { applyApprovals } from "../lib/engine/learn";
import { recordOverride, revokeOverride } from "../lib/engine/overrides";
import { buildPreSendReport } from "../lib/engine/presend";
import { previewImpact } from "../lib/engine/tools";
import { computePreview, stagedWithEdits, type Preview } from "../lib/app/analysis_view";
import { buildPresendView, workingDraft } from "../lib/app/presend_view";
import { proposeFor, describeFinding } from "../lib/app/propose";
import { analyseMessage, type AnalyzeResponse } from "../lib/app/run_analysis";
import { discardStoredAnalysis, loadAnalysis, loadRecord, resetApp, saveAnalysis, saveRecord, type Approval } from "../lib/app/store";

const MERCHANT = "Sunita Reddy";

const refresh = () => revalidatePath("/", "layout");

// ---------------------------------------------------------------- pre-send
/** Take the agent's proposal for one open business finding. The proposal is rebuilt here, never trusted from the page. */
export async function approveFinding(invoiceId: string, ruleId: string): Promise<{ ok: boolean; error?: string }> {
  const w = workingDraft(invoiceId);
  if (w.readOnly) return { ok: false, error: "This invoice can no longer be changed." };

  const report = buildPreSendReport({ invoice: w.current.invoice, buyer: w.buyer, annexure: w.current.annexure }, w.rules);
  const item = report.business.find((i) => i.finding.rule_id === ruleId);
  const rule = w.rules.find((r) => r.rule_id === ruleId);
  const proposal = item ? proposeFor(item, rule, w.current) : null;
  if (!item || !proposal) return { ok: false, error: "There is nothing to apply for this finding any more." };

  const delta = previewImpact(w.current, proposal.calls).delta;
  const lineIds = proposal.calls.flatMap((c) => ("line_id" in c && c.line_id ? [c.line_id] : []));
  const approval: Approval = {
    rule_id: ruleId,
    title: describeFinding(item, rule).title,
    resolved: proposal.resolved,
    note: proposal.note,
    line_ids: lineIds.length ? lineIds : item.finding.line_ids,
    calls: proposal.calls,
    wage_cut: delta.wage_reduction_inr,
    total_cut: delta.total_reduction_inr,
    at: new Date().toISOString(),
  };
  saveRecord(invoiceId, { ...w.record, approved: [...w.record.approved.filter((a) => a.rule_id !== ruleId), approval] });
  refresh();
  return { ok: true };
}

/** Waive one business finding for this invoice only. The rule is untouched. */
export async function waiveFinding(invoiceId: string, ruleId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const w = workingDraft(invoiceId);
  if (w.readOnly) return { ok: false, error: "This invoice can no longer be changed." };
  const report = buildPreSendReport({ invoice: w.current.invoice, buyer: w.buyer, annexure: w.current.annexure }, w.rules);
  try {
    const done = recordOverride(loadOverrides(), report, { rule_id: ruleId, reason: reason.slice(0, 300), by: MERCHANT });
    saveOverrides(done.overrides);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  refresh();
  return { ok: true };
}

/** Put a resolved row back as an open finding. */
export async function undoDecision(invoiceId: string, ruleId: string): Promise<{ ok: boolean }> {
  const record = loadRecord(invoiceId);
  if (record.sent_at) return { ok: false };
  if (record.approved.some((a) => a.rule_id === ruleId)) {
    saveRecord(invoiceId, { ...record, approved: record.approved.filter((a) => a.rule_id !== ruleId) });
  } else {
    const done = revokeOverride(loadOverrides(), invoiceId, ruleId);
    if (done.removed) saveOverrides(done.overrides);
  }
  refresh();
  return { ok: true };
}

/** Mark the invoice sent. No email goes anywhere: v1 stops at the decision. */
export async function sendInvoice(invoiceId: string): Promise<{ ok: boolean; error?: string }> {
  const w = workingDraft(invoiceId);
  if (w.readOnly) return { ok: false, error: "This invoice has already gone out." };
  if (!buildPresendView(invoiceId).sendable) return { ok: false, error: "Something is still open on this invoice." };
  saveRecord(invoiceId, { ...w.record, sent_at: new Date().toISOString(), sent_total: w.current.invoice.totals.grand_total });
  refresh();
  return { ok: true };
}

// ---------------------------------------------------------------- dispute
export type AnalyzeState = { response: AnalyzeResponse | null; text: string };

/** Form action for the paste box. Redirects to the analysis on success. */
export async function analyzeAction(invoiceId: string, _prev: AnalyzeState, form: FormData): Promise<AnalyzeState> {
  const text = String(form.get("message") ?? "");
  const response = await analyseMessage(invoiceId, text);
  if (!response.ok) return { response, text };
  refresh();
  redirect(`/invoices/${invoiceId}/dispute`);
}

/** Throw away an analysis that has not been saved, to paste a different message. */
export async function discardAnalysis(invoiceId: string): Promise<{ ok: boolean }> {
  const stored = loadAnalysis(invoiceId);
  if (!stored || stored.resolved) return { ok: false };
  discardStoredAnalysis(invoiceId);
  refresh();
  return { ok: true };
}

/** What the invoice would look like under the merchant's current choices. Money from the engine. */
export async function previewDecision(invoiceId: string, include: string[], edits: Record<string, number>): Promise<Preview | null> {
  const stored = loadAnalysis(invoiceId);
  return stored ? computePreview(stored.result, include, edits) : null;
}

export interface CommitInput {
  approved: string[];
  declined: { claim_id: string; reason: string }[];
  edits: Record<string, number>;
  /** Indexes into the proposed rules the merchant wants taught. */
  learn: number[];
}

/** Close the loop: apply the approved business changes, write the rules, file the dispute. */
export async function commitAnalysis(invoiceId: string, input: CommitInput): Promise<{ ok: boolean; error?: string }> {
  const stored = loadAnalysis(invoiceId);
  if (!stored) return { ok: false, error: "There is no analysis to save." };
  if (stored.resolved) return { ok: false, error: "This dispute is already saved." };
  const { result } = stored;

  const stagedIds = new Set(result.staged.map((s) => s.claim_id));
  const approved = input.approved.filter((id) => stagedIds.has(id));
  const declined = [...stagedIds].filter((id) => !approved.includes(id));
  const reasons = Object.fromEntries(input.declined.filter((d) => d.reason.trim()).map((d) => [d.claim_id, d.reason.trim().slice(0, 300)]));

  // A rule taught only by a claim the merchant declined is not learned. A rule the ledger already had
  // is corroborated whenever its claim was not declined.
  const declinedSet = new Set(declined);
  const learn = result.proposed_rules
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => {
      const ids = p.proposal.claim_ids;
      if (ids.length && ids.every((id) => declinedSet.has(id))) return false;
      return p.duplicate_of !== null || input.learn.includes(i);
    })
    .map(({ i }) => i);
  const skipped = result.proposed_rules.map((_, i) => i).filter((i) => !learn.includes(i) && result.proposed_rules[i]!.duplicate_of === null);

  const edited = { ...result, staged: stagedWithEdits(result, input.edits) };
  const resolution = applyApprovals(edited, { ledger: loadLedger(), disputes: loadAllDisputes() }, {
    approve_claims: approved, approve_rules: learn, decline_reasons: reasons,
  });
  saveLedger(resolution.ledger);
  recordOutcome(resolution.dispute, resolution.merchant_accepted);

  const delta = compareInvoices(result.draft.invoice, resolution.invoice);
  saveAnalysis(invoiceId, {
    ...stored,
    resolved: {
      at: new Date().toISOString(),
      dispute_id: resolution.dispute.dispute_id,
      approved,
      declined: declined.map((claim_id) => ({ claim_id, reason: reasons[claim_id] ?? null })),
      edited_qty: input.edits,
      skipped_rules: skipped,
      written: resolution.written,
      corroborated: resolution.corroborated,
      revised_total: resolution.invoice.totals.grand_total,
      total_reduction: delta.total_reduction_inr,
      wage_reduction: delta.wage_reduction_inr,
      ledger_size: resolution.ledger.length,
    },
  });
  refresh();
  return { ok: true };
}

// ------------------------------------------------------------------ rules
/** Switch a rule off or on. A rule that is off is neither checked nor shown to the agent. */
export async function setRuleStatus(ruleId: string, status: "active" | "disabled"): Promise<{ ok: boolean }> {
  const ledger = loadLedger();
  if (!ledger.some((r) => r.rule_id === ruleId)) return { ok: false };
  saveLedger(ledger.map((r) => (r.rule_id === ruleId ? { ...r, status } : r)));
  refresh();
  return { ok: true };
}

// ------------------------------------------------------------------- demo
/** Back to the start: the seeded ledger, no saved analyses, no decisions, no overrides. */
export async function resetDemo(): Promise<void> {
  resetState();
  resetApp();
  refresh();
  redirect("/");
}
