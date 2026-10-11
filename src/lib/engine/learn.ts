import type { Bucket, Confidence, Dispute, Invoice, Rule } from "../schema";
import type { AnalysisResult } from "./analyze";
import { applyToolCall, type LogEntry } from "./tools";

/**
 * Closing the loop. Once the merchant has decided, the dispute becomes a record,
 * the rules it taught are written to the ledger, and rules it merely repeated
 * are corroborated. The next invoice's pre-send check reads that ledger, which is
 * what turns dispute resolution into dispute prevention.
 *
 * Pure: takes the ledger and history in, returns the new ones. Persisting is the
 * caller's job (see load.ts), so a test can run the whole loop without touching disk.
 */

export interface Decision {
  /** Business claims the merchant approved. Format claims need no approval. */
  approve_claims: string[];
  /** Indexes into proposed_rules, or "all". Rules the merchant does not approve are not learned. */
  approve_rules: number[] | "all";
  /**
   * Why a business claim was not approved, keyed by claim id: something the agent could not know. Optional.
   * It goes on the dispute's record, which later disputes see as history.
   */
  decline_reasons?: Record<string, string>;
}

export interface Corroboration {
  rule_id: string;
  times_before: number;
  times_after: number;
  confidence_before: Confidence;
  confidence_after: Confidence;
}

export interface Resolution {
  dispute: Dispute;
  /** The invoice after the approved business changes, recomputed. */
  invoice: Invoice;
  ledger: Rule[];
  written: Rule[];
  corroborated: Corroboration[];
  /** Business claims left as proposals, not approved. */
  declined: string[];
  merchant_accepted: boolean;
  log: LogEntry[];
}

/** DSP-018 -> 19, across every dispute the system knows about. */
export function nextDisputeId(known: { dispute_id: string }[]): string {
  const max = known.reduce((m, d) => Math.max(m, Number(d.dispute_id.replace(/\D/g, "")) || 0), 0);
  return `DSP-${String(max + 1).padStart(3, "0")}`;
}

/** MER-R1 -> "MER". New buyers with no rules yet fall back to the first letters of their id. */
function prefixFor(buyerId: string, ledger: Rule[]): string {
  const existing = ledger.find((r) => r.buyer_id === buyerId)?.rule_id.match(/^([A-Z]+)-R\d+$/);
  return existing ? existing[1]! : buyerId.replace(/^BUY-/, "").slice(0, 3).toUpperCase();
}

/** Lowest unused number, so a rule withheld from the seed gets its own slot back. */
function nextRuleId(buyerId: string, ledger: Rule[]): string {
  const prefix = prefixFor(buyerId, ledger);
  const used = new Set(ledger.map((r) => r.rule_id));
  let n = 1;
  while (used.has(`${prefix}-R${n}`)) n++;
  return `${prefix}-R${n}`;
}

const CONFIDENCE_UP: Record<Confidence, Confidence> = { low: "medium", medium: "high", high: "high" };

/**
 * upsertRule(): add a rule, or when an active rule already enforces the same
 * thing, record that it was seen again. Returns the new ledger.
 */
export function upsertRule(
  ledger: Rule[],
  next: { buyer_id: string; type: Bucket; rule_text: string; source_dispute_id: string; confidence: Confidence; check: Rule["check"] },
): { ledger: Rule[]; rule: Rule; created: boolean } {
  const twin = next.check
    ? ledger.find((r) => r.buyer_id === next.buyer_id && r.status === "active" && JSON.stringify(r.check) === JSON.stringify(next.check))
    : undefined;
  if (twin) {
    const updated = corroborate(twin, next.source_dispute_id);
    return { ledger: ledger.map((r) => (r.rule_id === twin.rule_id ? updated : r)), rule: updated, created: false };
  }
  const rule: Rule = {
    rule_id: nextRuleId(next.buyer_id, ledger),
    buyer_id: next.buyer_id,
    type: next.type,
    rule: next.rule_text,
    // One dispute is one observation. The model may feel sure, but only a second
    // sighting (see corroborate) earns "high".
    confidence: next.confidence === "high" ? "medium" : next.confidence,
    learned_from: [next.source_dispute_id],
    status: "active",
    times_corroborated: 1,
    check: next.check,
  };
  return { ledger: [...ledger, rule], rule, created: true };
}

function corroborate(rule: Rule, disputeId: string): Rule {
  if (rule.learned_from.includes(disputeId)) return rule;
  const times = rule.times_corroborated + 1;
  return {
    ...rule,
    learned_from: [...rule.learned_from, disputeId],
    times_corroborated: times,
    // Seen twice is a pattern; seen once is an observation.
    confidence: times >= 2 ? CONFIDENCE_UP[rule.confidence] : rule.confidence,
  };
}

export function applyApprovals(
  result: AnalysisResult,
  state: { ledger: Rule[]; disputes: { dispute_id: string }[] },
  decision: Decision,
): Resolution {
  const disputeId = nextDisputeId(state.disputes);
  const approved = new Set(decision.approve_claims);

  // Business changes, as the merchant, on top of the draft the automatic fixes produced.
  let draft = result.draft;
  const declined: string[] = [];
  for (const s of result.staged) {
    if (!approved.has(s.claim_id)) {
      declined.push(s.claim_id);
      continue;
    }
    for (const call of s.calls) draft = applyToolCall(draft, call, { actor: "merchant" }).draft;
  }

  let ledger = state.ledger;
  const corroborated: Corroboration[] = [];
  const written: Rule[] = [];

  // Claims an existing rule already covered: the rule was right, say so.
  for (const o of result.outcomes) {
    if (!o.foresight || o.status === "rejected") continue;
    if (o.claim.bucket === "business" && !approved.has(o.claim.claim_id)) continue;
    const before = ledger.find((r) => r.rule_id === o.foresight!.rule_id);
    if (!before) continue;
    const after = corroborate(before, disputeId);
    if (after === before) continue;
    ledger = ledger.map((r) => (r.rule_id === before.rule_id ? after : r));
    corroborated.push({
      rule_id: before.rule_id, times_before: before.times_corroborated, times_after: after.times_corroborated,
      confidence_before: before.confidence, confidence_after: after.confidence,
    });
  }

  // Rules this dispute taught.
  const wanted = decision.approve_rules === "all" ? result.proposed_rules.map((_, i) => i) : decision.approve_rules;
  for (const i of wanted) {
    const p = result.proposed_rules[i];
    if (!p) continue;
    const before = ledger;
    const r = upsertRule(ledger, {
      buyer_id: result.buyer_id, type: p.proposal.type, rule_text: p.proposal.rule, source_dispute_id: disputeId,
      confidence: p.proposal.confidence, check: p.proposal.check,
    });
    ledger = r.ledger;
    if (r.created) written.push(r.rule);
    else {
      const was = before.find((x) => x.rule_id === r.rule.rule_id)!;
      corroborated.push({
        rule_id: was.rule_id, times_before: was.times_corroborated, times_after: r.rule.times_corroborated,
        confidence_before: was.confidence, confidence_after: r.rule.confidence,
      });
    }
  }

  const applied = draft.log.filter((e) => e.status === "applied" && e.tool !== "apply_template").map((e) => e.message);
  const resolution =
    `Resolved on ${result.received_on}. ` +
    (applied.length ? `Applied: ${applied.join("; ")}.` : "Nothing applied.") +
    (declined.length
      ? ` Not approved: ${declined
          .map((id) => (decision.decline_reasons?.[id]?.trim() ? `${id} (${decision.decline_reasons[id]!.trim()})` : id))
          .join(", ")}.`
      : "") +
    (written.length ? ` Learned: ${written.map((r) => r.rule_id).join(", ")}.` : "");

  const dispute: Dispute = {
    dispute_id: disputeId,
    buyer_id: result.buyer_id,
    invoice_id: result.invoice_id,
    received_at: result.received_on,
    channel: "email",
    detected_how: "pasted into the agent",
    raw_text: result.context.message,
    buckets: [...new Set(result.outcomes.map((o) => o.claim.bucket))],
    resolution,
    days_delayed: null,
    amount_disputed: result.money.total_reduction_inr,
  };

  return {
    dispute, invoice: draft.invoice, ledger, written, corroborated, declined,
    merchant_accepted: declined.length === 0 && result.staged.length > 0,
    log: draft.log,
  };
}
