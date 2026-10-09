import {
  BUCKET_AUTONOMY,
  type Annexure,
  type AnnexureRow,
  type Buyer,
  type Check,
  type CheckResult,
  type FactValue,
  type Invoice,
  type InvoiceLine,
  type Rule,
} from "../schema";

/**
 * runChecks() is a plain linter. The model infers a rule's `check` from a messy
 * email; this file enforces it with no model access at all. Findings carry
 * quantities and names, never rupees: money comes only from recomputeInvoice().
 */

export interface CheckContext {
  invoice: Invoice;
  buyer: Buyer;
  /** Person-level detail behind the invoice, when one exists. */
  annexure: Annexure | null;
}

type Verdict =
  | { outcome: "pass" }
  | { outcome: "fail"; message: string; lineIds: string[]; facts: Record<string, FactValue> }
  | { outcome: "manual"; note: string };

const pass = (): Verdict => ({ outcome: "pass" });
const manual = (note: string): Verdict => ({ outcome: "manual", note });
const fail = (
  message: string,
  lineIds: string[] = [],
  facts: Record<string, FactValue> = {},
): Verdict => ({ outcome: "fail", message, lineIds, facts });

// ------------------------------------------------------------------ helpers
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const dayOf = (iso: string) => Number(iso.slice(8, 10));
const daysBetween = (fromIso: string, toIso: string) => Math.round((utc(toIso) - utc(fromIso)) / 86_400_000);

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]!);
}

const isOvertimeLine = (l: InvoiceLine) => l.unit === "hours";
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

type LineField = "po_number" | "sac" | "description";
const lineValue = (line: InvoiceLine, field: LineField) => (line[field] ?? "") as string;
const FIELD_LABEL: Record<LineField, string> = {
  po_number: "PO number",
  sac: "SAC code",
  description: "description",
};

const NEEDS_ANNEXURE = (invoice: Invoice) =>
  manual(`No annexure is available for ${invoice.invoice_id}, so this cannot be verified.`);

// --------------------------------------------------------------- evaluators
function evaluate(check: Check, ctx: CheckContext): Verdict {
  const { invoice, buyer, annexure } = ctx;
  const lines = invoice.lines;

  switch (check.kind) {
    case "line_field_required": {
      const missing = lines.filter((l) => !lineValue(l, check.field).trim());
      if (!missing.length) return pass();
      return fail(
        `${missing.length} of ${lines.length} lines carry no ${FIELD_LABEL[check.field]}`,
        missing.map((l) => l.line_id),
        { field: check.field, missing: missing.length, lines_checked: lines.length },
      );
    }

    case "line_field_matches": {
      const re = new RegExp(check.pattern);
      const bad = lines.filter((l) => !re.test(lineValue(l, check.field)));
      if (!bad.length) return pass();
      return fail(
        `${bad.length} of ${lines.length} lines have no valid ${FIELD_LABEL[check.field]}`,
        bad.map((l) => l.line_id),
        { field: check.field, pattern: check.pattern, nonconforming: bad.length, lines_checked: lines.length },
      );
    }

    case "lines_grouped_by": {
      const siteName = (code: string) => buyer.sites.find((x) => x.code === code)?.name ?? code;
      const seen = new Set<string>();
      const scattered = new Set<string>();
      let previous: string | null = null;
      for (const l of lines) {
        const key = l.site_code;
        if (key !== previous && seen.has(key)) scattered.add(siteName(key));
        seen.add(key);
        previous = key;
      }
      if (!scattered.size) return pass();
      return fail(
        `Lines are not grouped site-wise: ${[...scattered].join(", ")} ${scattered.size === 1 ? "is" : "are"} split across the invoice`,
        [],
        { interleaved_sites: [...scattered] },
      );
    }

    case "annexure_field_required_when": {
      if (!annexure) return NEEDS_ANNEXURE(invoice);
      const bad = annexure.rows.filter(
        (r) => r[check.when_field] > check.when_gt && !r[check.field],
      );
      if (!bad.length) return pass();
      // The annexure is an extract; its OT summary is the authoritative ledger.
      const summary = annexure.ot_summary;
      const unreferenced = summary?.hours_without_authorisation ?? bad.reduce((sum, r) => sum + r.ot_hours, 0);
      // Only the overtime lines at sites where more hours were billed than authorised.
      const overBilled = (l: InvoiceLine) => {
        const site = summary?.by_site[l.site_code];
        return !site || l.qty > site.authorised_hours;
      };
      return fail(
        `${unreferenced} overtime hours carry no authorisation reference`,
        lines.filter((l) => isOvertimeLine(l) && overBilled(l)).map((l) => l.line_id),
        {
          unreferenced_hours: unreferenced,
          rows_without_reference: bad.length,
          workers: bad.map((r) => r.emp_name),
        },
      );
    }

    case "days_billed_capped_by_last_working_day": {
      if (!annexure) return NEEDS_ANNEXURE(invoice);
      const over = annexure.rows
        .filter((r): r is AnnexureRow & { last_working_day: string } => r.last_working_day !== null)
        .map((r) => {
          const allowed = Math.max(0, daysBetween(invoice.period_start, r.last_working_day) + 1);
          return { row: r, allowed, excess: r.days_billed - allowed };
        })
        .filter((x) => x.excess > 0);
      if (!over.length) return pass();
      const lineIds = new Set<string>();
      for (const { row } of over) {
        for (const l of lines) if (l.role === row.role && l.site_code === row.site) lineIds.add(l.line_id);
      }
      const total = over.reduce((s, x) => s + x.excess, 0);
      return fail(
        `${plural(over.length, "exited worker")} billed past the last working day (${plural(total, "man-day")} over)`,
        [...lineIds],
        {
          excess_man_days: total,
          workers: over.map(
            (x) => `${x.row.emp_name}: ${x.excess} days over (billed ${x.row.days_billed}, last day ${x.row.last_working_day})`,
          ),
        },
      );
    }

    case "invoice_date_window": {
      const day = dayOf(invoice.invoice_date);
      if (day >= check.from_day && day <= check.to_day) return pass();
      return fail(
        `Invoice is dated ${invoice.invoice_date}, outside the buyer's ${ordinal(check.from_day)}-${ordinal(check.to_day)} submission window`,
        [],
        { invoice_date: invoice.invoice_date, window: `${ordinal(check.from_day)}-${ordinal(check.to_day)}` },
      );
    }

    case "service_charge_base": {
      if (invoice.totals.service_charge_base === check.expected) return pass();
      return fail(
        `Service charge is on ${invoice.totals.service_charge_base}, but this buyer's contract is ${check.expected}`,
        [],
        { actual: invoice.totals.service_charge_base, expected: check.expected },
      );
    }

    case "billing_period_cycle": {
      if (dayOf(invoice.period_start) === check.start_day && dayOf(invoice.period_end) === check.end_day)
        return pass();
      return fail(
        `Billing period ${invoice.period_start} to ${invoice.period_end} does not run the ${ordinal(check.start_day)} to the ${ordinal(check.end_day)}`,
        [],
        { period_start: invoice.period_start, period_end: invoice.period_end },
      );
    }

    case "payment_terms_days": {
      const actual = daysBetween(invoice.invoice_date, invoice.due_date);
      if (actual === check.days) return pass();
      return fail(
        `Invoice states ${actual}-day payment terms, but this buyer pays on ${check.days} days`,
        [],
        { stated_days: actual, expected_days: check.days },
      );
    }

    case "manual_review":
      return manual(check.note);
  }
}

// -------------------------------------------------------------------- entry
/**
 * Run every active rule for the invoice's buyer. Disabled rules are dropped
 * entirely. A rule that cannot be mechanised, or whose evidence is missing,
 * comes back as "manual" so it is surfaced to a person and never silently passes.
 */
export function runChecks(ctx: CheckContext, rules: Rule[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const rule of rules) {
    if (rule.status !== "active" || rule.buyer_id !== ctx.invoice.buyer_id) continue;

    const base = { rule_id: rule.rule_id, bucket: rule.type, rule_text: rule.rule };
    if (!rule.check) {
      results.push({ ...base, outcome: "manual", note: "No machine-readable check exists for this rule." });
      continue;
    }

    let verdict: Verdict;
    try {
      verdict = evaluate(rule.check, ctx);
    } catch (err) {
      verdict = manual(`The check could not be evaluated: ${(err as Error).message}`);
    }

    if (verdict.outcome === "pass") results.push({ ...base, outcome: "pass" });
    else if (verdict.outcome === "manual") results.push({ ...base, outcome: "manual", note: verdict.note });
    else
      results.push({
        ...base,
        outcome: "fail",
        finding: {
          rule_id: rule.rule_id,
          bucket: rule.type,
          autonomy: BUCKET_AUTONOMY[rule.type],
          message: verdict.message,
          line_ids: verdict.lineIds,
          facts: verdict.facts,
        },
      });
  }

  return results;
}
