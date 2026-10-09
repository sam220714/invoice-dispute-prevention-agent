import type { AnalysisResult, ClaimOutcome } from "../lib/engine/analyze";
import type { Resolution } from "../lib/engine/learn";
import type { PreSendReport, ReportItem } from "../lib/engine/presend";
import type { LogEntry } from "../lib/engine/tools";

/**
 * Plain-text view of a pre-send report. Pure: no I/O, no colour unless asked,
 * and ASCII only so it survives a Windows console.
 */

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", green: "\x1b[32m" };

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** ["L1","L2","L3","L9"] -> "L1-L3, L9" */
export function compactLines(ids: string[]): string {
  const nums = ids.map((id) => ({ id, n: Number(id.replace(/\D/g, "")) }));
  if (nums.some((x) => Number.isNaN(x.n))) return ids.join(", ");
  nums.sort((a, b) => a.n - b.n);
  const out: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1]!.n === nums[j]!.n + 1) j++;
    out.push(j > i ? `${nums[i]!.id}-${nums[j]!.id}` : nums[i]!.id);
    i = j + 1;
  }
  return out.join(", ");
}

/** What the engine changed, grouped so eight per-line edits read as one line. */
export function summariseApplied(log: LogEntry[]): string[] {
  const steps = log.filter((e) => e.status === "applied" && e.actor === "engine" && e.tool !== "apply_template");
  const groups = new Map<string, LogEntry[]>();
  for (const e of steps) {
    const field = (e.args as { field?: string }).field;
    const key = e.tool === "set_field" && field ? `set_field:${field}` : e.tool;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const first = entries[0]!;
    return first.message;
  });
}

export function renderReport(report: PreSendReport, opts: { color?: boolean; applied?: string[] } = {}): string {
  const c = (code: keyof typeof ANSI, s: string) => (opts.color ? ANSI[code] + s + ANSI.reset : s);
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const rule = (ch = "-") => line(c("dim", ch.repeat(78)));

  rule("=");
  line(c("bold", `PRE-SEND CHECK  ${report.invoice_id}`));
  line(`${report.buyer_name} | ${report.period_label} | ${report.status} | dated ${report.invoice_date}`);
  rule("=");
  line();

  const { business, format } = report;
  if (report.can_send_as_is) {
    line(c("green", "Nothing found. This invoice matches every rule in the buyer's ledger."));
  } else {
    line(
      [
        c("yellow", `${plural(business.length, "business item")} to review`),
        c("cyan", opts.applied
          ? `${plural(format.length, "format item")} left for a person`
          : `${plural(format.length, "format fix", "format fixes")} to auto-apply`),
      ].join("   |   "),
    );
  }
  line();

  const section = (title: string, hint: string, color: keyof typeof ANSI, items: ReportItem[]) => {
    if (!items.length) return;
    line(c(color, c("bold", `${title} (${items.length})`)) + c("dim", `  ${hint}`));
    for (const { finding, rule: r } of items) {
      line(`  [${r.rule_id}] ${finding.message}`);
      if (finding.line_ids.length) line(c("dim", `      lines: ${compactLines(finding.line_ids)}`));
      const workers = finding.facts.workers;
      if (Array.isArray(workers)) for (const w of workers) line(c("dim", `        - ${w}`));
      line(
        c(
          "dim",
          `      rule: ${r.rule}`,
        ),
      );
      line(
        c(
          "dim",
          `      learned from ${r.learned_from.join(", ")} | ${r.confidence} confidence`,
        ),
      );
      line();
    }
  };

  if (opts.applied) {
    line(c("green", c("bold", `AUTO-APPLIED (${opts.applied.length})`)) + c("dim", "  no amount was changed"));
    for (const a of opts.applied) line(`  + ${a}`);
    line();
  }

  section("BUSINESS", "propose, merchant approves", "yellow", business);
  section("FORMAT", opts.applied ? "could not be applied automatically" : "auto-apply", "cyan", format);

  if (report.manual.length) {
    line(c("bold", `NEEDS A HUMAN (${report.manual.length})`) + c("dim", "  the linter cannot decide these"));
    for (const m of report.manual) line(`  [${m.rule_id}] ${m.note}`);
    line();
  }

  if (report.passed.length) {
    line(c("green", `PASSED (${report.passed.length}): `) + report.passed.map((p) => p.rule_id).join(", "));
    line();
  }

  rule();
  const found = business.length + format.length;
  if (found) {
    const learned = `${plural(report.foreseen_by.length, "past dispute")}: ${report.foreseen_by.join(", ")}`;
    if (found === 1) {
      line(`The 1 finding comes from a rule already in the ledger, learned from ${learned}.`);
      line("It was foreseeable before the invoice went out.");
    } else {
      line(`All ${found} findings come from rules already in the ledger, learned from ${learned}.`);
      line("Each of these was foreseeable before the invoice went out.");
    }
  }
  line(
    c("dim", opts.applied
      ? "Fixes were applied in memory only. Nothing has been saved or sent."
      : "Detection only: no changes have been made to this invoice."),
  );
  return out.join("\n");
}

// ---------------------------------------------------------------- analysis
export const inr = (n: number) => "Rs " + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_LABEL: Record<ClaimOutcome["status"], string> = {
  applied: "AUTO-APPLIED", partial: "PARTLY APPLIED", proposed: "PROPOSED", needs_human: "NEEDS A HUMAN", rejected: "REFUSED",
};

export function renderAnalysis(r: AnalysisResult, opts: { color?: boolean } = {}): string {
  const c = (code: keyof typeof ANSI, s: string) => (opts.color ? ANSI[code] + s + ANSI.reset : s);
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const rule = (ch = "-") => line(c("dim", ch.repeat(78)));

  rule("=");
  line(c("bold", `DISPUTE ANALYSIS  ${r.invoice_id}`) + `   ${r.meta.model}${r.meta.repaired ? " (repaired once)" : ""}`);
  rule("=");
  line();

  r.outcomes.forEach((o, i) => {
    const colour = o.claim.bucket === "business" ? "yellow" : "cyan";
    line(c(colour, c("bold", `${o.claim.claim_id}  ${o.claim.bucket.toUpperCase()}`)) + `  ${STATUS_LABEL[o.status]}  ` + c("dim", `(${o.autonomy})`));
    line(`  ${o.claim.claim}`);
    line(c("dim", `  "${o.claim.quote.replace(/\s+/g, " ")}"`));
    if (o.claim.line_ids.length) line(c("dim", `  lines: ${compactLines(o.claim.line_ids)}`));
    for (const q of o.quantity_checks) {
      const tag = q.verdict === "corrected" ? c("red", "CORRECTED") : q.verdict === "verified" ? c("green", "verified") : q.verdict;
      line(`  ${q.line_id}: ${q.current_qty} -> ${q.final_qty}  [${tag}]  ${c("dim", q.basis)}`);
    }
    for (const s of o.steps) line(c("dim", `  ${s.status === "rejected" ? "x" : "-"} ${s.tool}: ${s.message}`));
    for (const u of o.unresolved) line(c("yellow", `  ! ${u.rule_id}: ${compactLines(u.line_ids)} ${u.reason}`));
    if (o.impact) line(`  if approved: wages -${inr(o.impact.wage_reduction_inr)}, invoice -${inr(o.impact.total_reduction_inr)}`);
    if (o.foresight)
      line(c("green", `  FORESEEABLE: ${o.foresight.rule_id}, learned from ${o.foresight.learned_from.join(", ")}`) +
        c("dim", o.foresight.linter_flagged ? " | the linter would have flagged it before sending" : " | the linter cannot test this one"));
    else line(c("dim", "  not in the ledger: new to the agent"));
    if (i < r.outcomes.length - 1) line();
  });
  line();
  rule();

  line(c("bold", `FORESEEABILITY  ${r.foreseen.matched} of ${r.foreseen.total} claims were already in the ledger`) +
    c("dim", `  (${r.foreseen.rule_ids.join(", ")}; from ${r.foreseen.source_disputes.join(", ")})`));
  line();
  line(c("bold", "MONEY") + c("dim", "  every figure from recomputeInvoice(), none from the model"));
  line(`  original invoice      ${inr(r.money.original_total_inr)}`);
  line(`  wages removed         ${inr(r.money.wage_reduction_inr)}`);
  line(`  invoice reduced by    ${inr(r.money.total_reduction_inr)}`);
  line(c("green", `  collectable now       ${inr(r.money.collectable_now_inr)}`) + c("dim", "   (once the business claims are approved)"));
  line();

  if (r.proposed_rules.length) {
    line(c("bold", `NEW RULES TO LEARN (${r.proposed_rules.length})`));
    r.proposed_rules.forEach((p, i) => {
      line(`  [${i}] ${p.proposal.type}: ${p.proposal.rule}`);
      line(c("dim", `      check: ${JSON.stringify(p.proposal.check)} | ${p.proposal.confidence} confidence${p.duplicate_of ? ` | already enforced by ${p.duplicate_of}` : ""}`));
    });
    line();
  }
  if (r.unclear.length) {
    line(c("bold", "UNCLEAR"));
    for (const u of r.unclear) line(`  ? ${u}`);
    line();
  }

  const a = r.after_fixes;
  line(c("bold", "AFTER THE AUTOMATIC FIXES") + `  ${a.format.length} format item(s) left for a person`);
  line(a.can_send_as_is ? c("green", "  Safe to send.") : c("red", "  Not safe to send yet."));
  line(c("dim", "Nothing has been saved. Business changes are proposals until the merchant approves them."));
  return out.join("\n");
}

export function renderResolution(res: Resolution, opts: { color?: boolean } = {}): string {
  const c = (code: keyof typeof ANSI, s: string) => (opts.color ? ANSI[code] + s + ANSI.reset : s);
  const out: string[] = [c("bold", `RESOLVED  ${res.dispute.dispute_id}`) + `  ${res.merchant_accepted ? "merchant approved the proposal" : "partly approved"}`];
  out.push(`  invoice now ${inr(res.invoice.totals.grand_total)}`);
  for (const w of res.written) out.push(c("green", `  + learned ${w.rule_id}: ${w.rule}`));
  for (const k of res.corroborated)
    out.push(`  ~ ${k.rule_id} corroborated ${k.times_before}x -> ${k.times_after}x` +
      (k.confidence_before !== k.confidence_after ? `, confidence ${k.confidence_before} -> ${k.confidence_after}` : ""));
  if (res.declined.length) out.push(`  not approved: ${res.declined.join(", ")}`);
  return out.join("\n");
}
