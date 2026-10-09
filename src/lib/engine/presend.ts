import type { Bucket, CheckResult, Finding, Rule } from "../schema";
import { runChecks, type CheckContext } from "./checks";

/**
 * The pre-send check as data: one invoice, two sections, one per bucket. The
 * CLI and (later) the screen are both thin views over this. Detection only: it
 * reports what the ledger says is wrong and changes nothing.
 */

/** A finding with the ledger rule that produced it, for provenance. */
export interface ReportItem {
  finding: Finding;
  rule: Pick<Rule, "rule_id" | "rule" | "confidence" | "learned_from" | "times_corroborated">;
}

export interface PreSendReport {
  invoice_id: string;
  buyer_name: string;
  period_label: string;
  invoice_date: string;
  status: string;
  /** Touches revenue: propose, merchant approves. */
  business: ReportItem[];
  /** Deterministic once learned: auto-apply. */
  format: ReportItem[];
  /** Rules the linter could not decide; a person has to look. */
  manual: CheckResult[];
  passed: CheckResult[];
  /** True only when both sections are empty. */
  can_send_as_is: boolean;
  /** Distinct past disputes the findings trace back to. */
  foreseen_by: string[];
}

export function buildPreSendReport(ctx: CheckContext, rules: Rule[]): PreSendReport {
  const results = runChecks(ctx, rules);
  const ruleById = new Map(rules.map((r) => [r.rule_id, r]));

  const section = (bucket: Bucket): ReportItem[] =>
    results
      .filter((r) => r.outcome === "fail" && r.bucket === bucket)
      .map((r) => {
        const rule = ruleById.get(r.rule_id)!;
        return {
          finding: r.finding!,
          rule: {
            rule_id: rule.rule_id,
            rule: rule.rule,
            confidence: rule.confidence,
            learned_from: rule.learned_from,
            times_corroborated: rule.times_corroborated,
          },
        };
      });

  const business = section("business");
  const format = section("format");
  const foreseen_by = [
    ...new Set([...business, ...format].flatMap((i) => i.rule.learned_from)),
  ].sort();

  return {
    invoice_id: ctx.invoice.invoice_id,
    buyer_name: ctx.invoice.buyer_name,
    period_label: ctx.invoice.period_label,
    invoice_date: ctx.invoice.invoice_date,
    status: ctx.invoice.status,
    business,
    format,
    manual: results.filter((r) => r.outcome === "manual"),
    passed: results.filter((r) => r.outcome === "pass"),
    can_send_as_is: !business.length && !format.length,
    foreseen_by,
  };
}
