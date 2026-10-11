import { getBuyer, getInvoice, loadAllDisputes, loadAnnexure, loadLedger, loadOverrides } from "../data/load";
import { compareInvoices } from "../engine/arithmetic";
import { applyOverrides, type Overridden, type StaleSignal } from "../engine/overrides";
import { buildPreSendReport, type PreSendReport, type ReportItem } from "../engine/presend";
import { applyToolCall, createDraft, previewImpact, type Draft, type ToolCall } from "../engine/tools";
import type { Invoice, Rule } from "../schema";
import { compactLines, plural, shortDate, word } from "./format";
import { describeFinding, proposeFor } from "./propose";
import { loadRecord, type InvoiceRecord } from "./store";

/**
 * The pre-send screen as data. Everything the screen shows is computed here on the server from the
 * invoice, the ledger, the merchant's overrides and the decisions saved so far; the client only decides
 * what is selected and what is open. Every rupee comes from the arithmetic engine through the tool surface.
 */

// ------------------------------------------------------------------- shapes
export interface DisplayCall {
  tool: string;
  args: (string | number)[];
}

export interface Source {
  id: string;
  date: string | null;
}

export interface LineView {
  line_id: string;
  description: string;
  site_code: string;
  site_name: string;
  site_full: string;
  unit: string;
  qty0: number;
  qty1: number;
  amount0: number;
  amount1: number;
}

export interface TotalsView {
  wages: number;
  statutory: number;
  gst: number;
  total: number;
}

export interface NeedView {
  rule_id: string;
  bucket: "business" | "format";
  title: string;
  where: string;
  line_ids: string[];
  /** What approving the proposal takes off the invoice, from the engine. Null when there is no proposal. */
  amount: number | null;
  primary: string | null;
  keep: string | null;
  names: { name: string; detail: string }[];
  calls: DisplayCall[];
  rule: string;
  sources: Source[];
  confidence: string;
  corroborated: number;
  message: string;
  stale: StaleSignal | null;
  reopened: boolean;
}

export interface FixView {
  rule_id: string;
  text: string;
  sources: Source[];
}

export type HandledView =
  | { kind: "formats"; key: string; heading: string; note: string; fixes: FixView[] }
  | { kind: "approved"; key: string; rule_id: string; heading: string; note: string; cut: number; line_ids: string[]; undo: boolean }
  | { kind: "waived"; key: string; rule_id: string; heading: string; note: string; line_ids: string[]; undo: boolean; stale: StaleSignal | null };

export interface VerdictView {
  tone: "hold" | "ready" | "sent" | "as_sent";
  flag: string;
  say: string;
  sub: string;
  money: number | null;
  moneyNote: string;
}

export interface PresendView {
  invoice_id: string;
  buyer_id: string;
  buyer_name: string;
  buyer_short: string;
  period_label: string;
  invoice_date: string;
  status: string;
  /** Nothing can be decided here: the invoice has gone out or is already in dispute. */
  read_only: boolean;
  sent_at: string | null;
  verdict: VerdictView;
  needs: NeedView[];
  handled: HandledView[];
  manual: { rule_id: string; text: string; note: string }[];
  passed: { rule_id: string; text: string }[];
  lines: LineView[];
  grouped: boolean;
  base: TotalsView;
  now: TotalsView;
  /** The resolved decisions, in money: wages held and what that took off the invoice. */
  held: { wages: number; total: number } | null;
  sendable: boolean;
}

// ------------------------------------------------------------------ helpers
const totalsOf = (inv: Invoice): TotalsView => ({
  wages: inv.totals.wages,
  statutory: inv.totals.pf_employer + inv.totals.esi_employer + inv.totals.service_charge,
  gst: inv.totals.cgst + inv.totals.sgst,
  total: inv.totals.grand_total,
});

export function displayCall(call: ToolCall): DisplayCall {
  switch (call.tool) {
    case "adjust_line": return { tool: call.tool, args: [call.line_id, call.field, call.value] };
    case "remove_line": return { tool: call.tool, args: [call.line_id] };
    case "defer_line": return { tool: call.tool, args: [call.line_id, call.to_period] };
    case "split_invoice": return { tool: call.tool, args: [call.disputed_line_ids.join(", ")] };
    case "set_service_charge_base": return { tool: call.tool, args: [call.value] };
    case "set_field": return { tool: call.tool, args: call.line_id ? [call.field, call.value, call.line_id] : [call.field, call.value] };
    case "regroup_lines": return { tool: call.tool, args: [call.group_by] };
    default: return { tool: call.tool, args: [] };
  }
}

/** Sites appear as unbroken runs: nothing is split across the invoice. */
function isGroupedBySite(inv: Invoice): boolean {
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const l of inv.lines) {
    if (l.site_code !== previous && seen.has(l.site_code)) return false;
    seen.add(l.site_code);
    previous = l.site_code;
  }
  return true;
}

export function replayApprovals(draft: Draft, record: InvoiceRecord): Draft {
  let current = draft;
  for (const a of record.approved) for (const call of a.calls) current = applyToolCall(current, call, { actor: "merchant" }).draft;
  return current;
}

/** The format fix in words, for the "what" disclosure. */
function describeFix(item: ReportItem, rule: Rule | undefined, invoice: Invoice): string {
  const check = rule?.check;
  const n = Number(item.finding.facts.missing ?? item.finding.facts.nonconforming ?? invoice.lines.length);
  const onLines = n >= invoice.lines.length ? `all ${invoice.lines.length} lines` : plural(n, "line");
  if (check && (check.kind === "line_field_required" || check.kind === "line_field_matches")) {
    if (check.field === "po_number") return `PO ${invoice.po_number} written onto ${onLines}`;
    if (check.field === "sac") return `SAC ${invoice.sac} written onto ${onLines}`;
  }
  if (check?.kind === "lines_grouped_by") return "Lines regrouped site-wise";
  return `${item.finding.message}, fixed`;
}

/** "Shamshabad Hub" reads as "Shamshabad" when that is unambiguous; group headers keep the full name. */
export function siteLabels(sites: { code: string; name: string }[]) {
  const firsts = sites.map((s) => s.name.split(/\s+/)[0]!);
  const at = (code: string) => sites.findIndex((s) => s.code === code);
  return {
    full: (code: string) => sites[at(code)]?.name ?? code,
    short: (code: string) => {
      const i = at(code);
      return i < 0 ? code : firsts.filter((f) => f === firsts[i]).length === 1 ? firsts[i]! : sites[i]!.name;
    },
  };
}

// -------------------------------------------------------------------- build
/** The invoice as the engine has it right now: format fixes applied, the merchant's saved approvals replayed. */
export function workingDraft(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  const buyer = getBuyer(invoice.buyer_id);
  const annexure = loadAnnexure(invoiceId);
  const rules = loadLedger();
  const record = loadRecord(invoiceId);
  const sent = Boolean(record.sent_at);
  // Only an unsent draft can still be decided. A sent or disputed invoice is read as it went out.
  const readOnly = sent || invoice.status !== "draft";

  let baseDraft = createDraft({ invoice, buyer, annexure, rules });
  if (!readOnly || sent) baseDraft = applyToolCall(baseDraft, { tool: "apply_template" }, { actor: "engine" }).draft;
  const current = replayApprovals(baseDraft, record);
  return { invoice, buyer, annexure, rules, record, sent, readOnly, baseDraft, current };
}

export function buildPresendView(invoiceId: string): PresendView {
  const { invoice, buyer, annexure, rules, record, sent, readOnly, baseDraft, current } = workingDraft(invoiceId);
  const overrides = loadOverrides();
  const ruleOf = (id: string) => rules.find((r) => r.rule_id === id);

  const disputeDates = new Map(loadAllDisputes().map((d) => [d.dispute_id, d.received_at]));
  const sourcesOf = (ids: string[]): Source[] => ids.map((id) => ({ id, date: disputeDates.has(id) ? shortDate(disputeDates.get(id)!) : null }));

  // What the draft would look like with nothing decided: the format fixes the agent makes on its own.
  const asDrafted = buildPreSendReport({ invoice, buyer, annexure }, rules);

  const raw: PreSendReport = buildPreSendReport({ invoice: current.invoice, buyer, annexure: current.annexure }, rules);
  const reviewed = applyOverrides(raw, overrides);

  // ---- needs you
  const proposals = new Map<string, ReturnType<typeof proposeFor>>();
  const needs: NeedView[] = [];
  const toNeed = (item: ReportItem, bucket: "business" | "format"): NeedView => {
    const rule = ruleOf(item.finding.rule_id);
    const proposal = bucket === "business" && !readOnly ? proposeFor(item, rule, current) : null;
    proposals.set(item.finding.rule_id, proposal);
    const { title, names } = describeFinding(item, rule);
    return {
      rule_id: item.finding.rule_id,
      bucket,
      title,
      where: item.finding.line_ids.length ? compactLines(item.finding.line_ids) : "",
      line_ids: item.finding.line_ids,
      amount: proposal ? previewImpact(current, proposal.calls).delta.total_reduction_inr : null,
      primary: readOnly ? null : (proposal?.primary ?? null),
      keep: readOnly || bucket === "format" ? null : (proposal?.keep ?? "Waive for this invoice"),
      names,
      calls: proposal ? proposal.calls.map(displayCall) : [],
      rule: item.rule.rule,
      sources: sourcesOf(item.rule.learned_from),
      confidence: item.rule.confidence,
      corroborated: item.rule.times_corroborated,
      message: item.finding.message,
      stale: reviewed.signals[item.finding.rule_id] ?? null,
      reopened: reviewed.reopened.includes(item.finding.rule_id),
    };
  };
  // The linter reads the annexure, which a quantity change on the invoice does not touch, so a finding the
  // merchant has already fixed would keep firing. A saved approval is what closes it.
  const fixed = new Set(record.approved.map((a) => a.rule_id));
  for (const item of reviewed.business) if (!fixed.has(item.finding.rule_id)) needs.push(toNeed(item, "business"));

  // A format finding still open after the fixes ran is one the agent could not make: a person has to.
  const formatLeft = readOnly ? [] : reviewed.format;
  for (const item of formatLeft) needs.push(toNeed(item, "format"));

  // ---- already handled
  const handled: HandledView[] = [];
  const formatDone = readOnly && !sent ? asDrafted.format : asDrafted.format.filter((i) => !formatLeft.some((l) => l.finding.rule_id === i.finding.rule_id));
  if (formatDone.length) {
    handled.push({
      kind: "formats",
      key: "formats",
      heading: readOnly && !sent
        ? `${plural(formatDone.length, "format fix", "format fixes")} would have been applied`
        : `${plural(formatDone.length, "format fix", "format fixes")} applied`,
      note: "No amount changed",
      fixes: formatDone.map((i) => ({
        rule_id: i.finding.rule_id,
        text: describeFix(i, ruleOf(i.finding.rule_id), invoice),
        sources: sourcesOf(i.rule.learned_from),
      })),
    });
  }
  for (const a of [...record.approved].reverse()) {
    handled.push({
      kind: "approved", key: `approved:${a.rule_id}`, rule_id: a.rule_id,
      heading: a.resolved, note: a.note, cut: a.total_cut, line_ids: a.line_ids, undo: !readOnly,
    });
  }
  for (const w of reviewed.overridden as Overridden[]) {
    handled.push({
      kind: "waived", key: `waived:${w.override.rule_id}`, rule_id: w.override.rule_id,
      heading: `Waived: ${w.override.summary}`,
      note: w.override.reason ? `Your reason: ${w.override.reason}` : "No reason given",
      line_ids: [], undo: !readOnly, stale: w.signal,
    });
  }

  // ---- lines and totals
  const baseLines = new Map(baseDraft.invoice.lines.map((l) => [l.line_id, l]));
  const label = siteLabels(buyer.sites);
  const lines: LineView[] = current.invoice.lines.map((l) => {
    const b = baseLines.get(l.line_id) ?? l;
    return {
      line_id: l.line_id, description: l.description.replace(/ - .*$/, ""), site_code: l.site_code,
      site_name: label.short(l.site_code), site_full: label.full(l.site_code), unit: l.unit,
      qty0: b.qty, qty1: l.qty, amount0: b.amount, amount1: l.amount,
    };
  });

  const delta = compareInvoices(baseDraft.invoice, current.invoice);
  const held = record.approved.length ? { wages: delta.wage_reduction_inr, total: delta.total_reduction_inr } : null;

  // ---- verdict
  const open = needs.length;
  const runnable = needs.flatMap((n) => proposals.get(n.rule_id)?.calls ?? []);
  const atRisk = runnable.length ? previewImpact(current, runnable).delta.total_reduction_inr : null;
  const short = buyer.short_name;
  let verdict: VerdictView;
  if (sent) {
    verdict = {
      tone: "sent", flag: "SENT", say: `Sent to ${short}.`,
      sub: `${shortDate(record.sent_at!, true)}. ${reviewed.overridden.length ? `${plural(reviewed.overridden.length, "finding")} waived on the record.` : "Nothing was waived."}`,
      money: current.invoice.totals.grand_total, moneyNote: "invoice total",
    };
  } else if (readOnly) {
    const n = asDrafted.business.length + asDrafted.format.length;
    verdict = n
      ? {
          tone: "as_sent", flag: "AS SENT", say: `${plural(n, "problem")} the ledger already knew about.`,
          sub: `${short} has rejected ${n === 1 ? "this" : "these"} before. Nothing checked before it went out.`,
          money: null, moneyNote: "",
        }
      : {
          tone: "as_sent", flag: "AS SENT", say: "This invoice matched every rule.",
          sub: `Nothing in ${short}'s ledger would have stopped it.`, money: null, moneyNote: "",
        };
  } else if (open === 0) {
    verdict = {
      tone: "ready", flag: "READY", say: "Nothing left to argue about.",
      sub: reviewed.overridden.length
        ? `${plural(reviewed.overridden.length, "finding")} waived by you. ${short} has no other open objection.`
        : `${short} has no open objection to this invoice.`,
      money: current.invoice.totals.grand_total, moneyNote: "collectable, not disputed",
    };
  } else {
    const businessOpen = needs.filter((n) => n.bucket === "business").length;
    const everyKnown = needs.every((n) => n.sources.length > 0);
    verdict = {
      tone: "hold", flag: "HOLD",
      say: open === 1 ? "One decision before this can go out." : `${word(open).replace(/^./, (c) => c.toUpperCase())} decisions before this can go out.`,
      sub: everyKnown
        ? `${short} has rejected ${open === 1 ? "this" : open === 2 ? "both of these" : `all ${word(open)} of these`} before.`
        : businessOpen ? "Each one changes what is billed." : "A person has to fix this.",
      money: atRisk, moneyNote: atRisk === null ? "" : "at risk if sent as is",
    };
  }

  return {
    invoice_id: invoice.invoice_id,
    buyer_id: buyer.id,
    buyer_name: invoice.buyer_name,
    buyer_short: short,
    period_label: invoice.period_label,
    invoice_date: invoice.invoice_date,
    status: sent ? "sent" : invoice.status,
    read_only: readOnly,
    sent_at: record.sent_at ?? null,
    verdict,
    needs,
    handled,
    manual: reviewed.manual.map((m) => ({ rule_id: m.rule_id, text: m.rule_text, note: m.note ?? "" })),
    passed: reviewed.passed.map((p) => ({ rule_id: p.rule_id, text: p.rule_text })),
    lines,
    grouped: isGroupedBySite(current.invoice),
    base: totalsOf(baseDraft.invoice),
    now: totalsOf(current.invoice),
    held,
    sendable: !readOnly && open === 0,
  };
}

/** Findings open on a draft, for the rail badge: what a person still has to decide. */
export function openDecisions(invoiceId: string): number {
  return buildPresendView(invoiceId).needs.length;
}
