import type { CheckResult, Finding, Override } from "../schema";
import type { PreSendReport, ReportItem } from "./presend";

/**
 * Manual override. The agent flags a business finding or a manual-review item, and the merchant, who may
 * know something the ledger does not (a verbal approval, a contract change nobody wrote down), says it is
 * fine for this invoice. The invoice then goes out with the format fixes already applied and the finding
 * waived, on the record.
 *
 *  - Format fixes are never overridable. They are deterministic and cost nothing to apply.
 *  - An override is for one invoice. It never edits or switches off the rule.
 *  - It is tied to the finding as it looked when waived. If the invoice changes so the finding changes,
 *    the override no longer matches and the finding comes back.
 *  - Overrides pile up as a signal: a rule overridden on STALE_AFTER different invoices is marked "may be
 *    out of date" for the merchant to review. Nothing is changed automatically.
 *
 * Pure: the caller loads and saves the list (see load.ts).
 */

export const STALE_AFTER = 2;

export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

// ------------------------------------------------------------- fingerprints
export const fingerprintFinding = (f: Finding) => [f.rule_id, [...f.line_ids].sort().join(","), f.message].join("|");
export const fingerprintManual = (m: CheckResult) => [m.rule_id, "manual", m.note ?? ""].join("|");

// ---------------------------------------------------------------- staleness
export interface StaleSignal {
  rule_id: string;
  /** Invoices on which this rule's finding was overridden, oldest first by when it was done. */
  overridden_on: string[];
  /** The last reason given, so the merchant sees why before deciding the rule is wrong. */
  last_reason: string | null;
  may_be_out_of_date: boolean;
}

/** null when the rule has never been overridden. */
export function staleSignal(overrides: Override[], ruleId: string): StaleSignal | null {
  const mine = overrides.filter((o) => o.rule_id === ruleId).sort((a, b) => a.at.localeCompare(b.at));
  if (!mine.length) return null;
  const invoices = [...new Set(mine.map((o) => o.invoice_id))];
  const reasons = mine.filter((o) => o.reason);
  return {
    rule_id: ruleId,
    overridden_on: invoices,
    last_reason: reasons.length ? reasons[reasons.length - 1]!.reason : null,
    may_be_out_of_date: invoices.length >= STALE_AFTER,
  };
}

// -------------------------------------------------------------------- record
export interface OverrideInput {
  rule_id: string;
  reason?: string | null;
  by?: string | null;
  now?: Date;
}

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/**
 * Waive one business or manual-review finding on this invoice. `report` is the report as the linter produced
 * it, not one already filtered by applyOverrides. Overriding again replaces the earlier override.
 */
export function recordOverride(
  overrides: Override[],
  report: PreSendReport,
  input: OverrideInput,
): { overrides: Override[]; override: Override } {
  const { rule_id } = input;
  const at = (input.now ?? new Date()).toISOString();
  const common = { invoice_id: report.invoice_id, rule_id, reason: clean(input.reason), by: clean(input.by), at };

  const business = report.business.find((i) => i.finding.rule_id === rule_id);
  const manual = report.manual.find((m) => m.rule_id === rule_id);
  const format = report.format.find((i) => i.finding.rule_id === rule_id);

  if (format || (manual && manual.bucket === "format"))
    throw new OverrideError(`${rule_id} is a format rule. Format fixes are applied automatically and cannot be overridden.`);

  let override: Override;
  if (business) {
    override = {
      ...common, buyer_id: report.buyer_id, bucket: "business", kind: "finding",
      fingerprint: fingerprintFinding(business.finding), summary: business.finding.message,
    };
  } else if (manual) {
    override = {
      ...common, buyer_id: report.buyer_id, bucket: manual.bucket, kind: "manual_review",
      fingerprint: fingerprintManual(manual), summary: manual.note ?? manual.rule_text,
    };
  } else {
    throw new OverrideError(`Nothing to override: ${rule_id} has no open finding on ${report.invoice_id}.`);
  }

  return {
    override,
    overrides: [...overrides.filter((o) => !(o.invoice_id === override.invoice_id && o.rule_id === rule_id)), override],
  };
}

export function revokeOverride(overrides: Override[], invoiceId: string, ruleId: string): { overrides: Override[]; removed: boolean } {
  const kept = overrides.filter((o) => !(o.invoice_id === invoiceId && o.rule_id === ruleId));
  return { overrides: kept, removed: kept.length !== overrides.length };
}

// --------------------------------------------------------------------- apply
export interface Overridden {
  override: Override;
  /** The rule's staleness signal, with this override counted. */
  signal: StaleSignal;
}

export interface ReviewedReport extends PreSendReport {
  /** Business and manual-review findings the merchant waived on this invoice. */
  overridden: Overridden[];
  /** Findings that were overridden but have changed since, so they are open again. */
  reopened: string[];
  /** For findings still open: the rule has been overridden elsewhere. Keyed by rule id. */
  signals: Record<string, StaleSignal>;
  /** Nothing left that blocks sending: no business item and no format item open. Manual items never block. */
  sendable: boolean;
}

/**
 * The report with this invoice's overrides applied. Format findings are never hidden. A finding is hidden only
 * while it still matches the one the merchant waived.
 */
export function applyOverrides(report: PreSendReport, overrides: Override[]): ReviewedReport {
  const mine = overrides.filter((o) => o.invoice_id === report.invoice_id && o.bucket !== "format");
  const overridden: Overridden[] = [];
  const reopened: string[] = [];

  const waived = (ruleId: string, fingerprint: string): Override | undefined => {
    const o = mine.find((x) => x.rule_id === ruleId);
    if (!o) return undefined;
    if (o.fingerprint === fingerprint) return o;
    reopened.push(ruleId);
    return undefined;
  };
  const record = (o: Override) => overridden.push({ override: o, signal: staleSignal(overrides, o.rule_id)! });

  const business = report.business.filter((i: ReportItem) => {
    const o = waived(i.finding.rule_id, fingerprintFinding(i.finding));
    if (o) record(o);
    return !o;
  });
  const manual = report.manual.filter((m) => {
    if (m.bucket === "format") return true;
    const o = waived(m.rule_id, fingerprintManual(m));
    if (o) record(o);
    return !o;
  });

  const signals: Record<string, StaleSignal> = {};
  for (const id of [...business.map((i) => i.finding.rule_id), ...manual.map((m) => m.rule_id)]) {
    const s = staleSignal(overrides, id);
    if (s) signals[id] = s;
  }

  const open = [...business, ...report.format];
  return {
    ...report,
    business,
    manual,
    overridden,
    reopened,
    signals,
    can_send_as_is: !open.length,
    sendable: !open.length,
    foreseen_by: [...new Set(open.flatMap((i) => i.rule.learned_from))].sort(),
  };
}
