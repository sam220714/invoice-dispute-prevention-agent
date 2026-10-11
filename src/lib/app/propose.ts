import type { Annexure, Invoice, InvoiceLine, Rule } from "../schema";
import { supportedQuantity } from "../engine/analyze";
import type { ReportItem } from "../engine/presend";
import type { Draft, ToolCall } from "../engine/tools";
import { compactLines, plural } from "./format";

/**
 * What the agent proposes for a business finding the linter raised on a draft.
 *
 * A finding says what is wrong; a proposal is the tool call that would put it right. Quantities come
 * from the annexure (the same evidence the dispute analysis checks the model against) and the call goes
 * through the same tool surface, so the amount is whatever recomputeInvoice() says it is. No money here.
 */

export interface Proposal {
  calls: ToolCall[];
  /** The button that applies it: names the action and its result. */
  primary: string;
  /** The button that waives it for this invoice. */
  keep: string;
  /** The card heading while the finding is open. */
  title: string;
  /** The heading of the resolved row. */
  resolved: string;
  /** One line under the resolved heading. */
  note: string;
}

export interface Described {
  title: string;
  /** Names to show under the card, when the finding carries them (exited workers). */
  names: { name: string; detail: string }[];
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** The finding in words a billing executive would use. Falls back to the linter's own message. */
export function describeFinding(item: ReportItem, rule: Rule | undefined): Described {
  const { finding: f } = item;
  const check = rule?.check;
  if (check?.kind === "annexure_field_required_when") {
    const hours = Number(f.facts.unreferenced_hours ?? 0);
    return { title: `${hours} overtime hours, no authorisation`, names: [] };
  }
  if (check?.kind === "days_billed_capped_by_last_working_day") {
    const workers = asStrings(f.facts.workers);
    const names = workers.map((w) => {
      const m = /^(.*?): (\d+) days over \(billed \d+, last day ([\d-]+)\)$/.exec(w);
      return m ? { name: m[1]!, detail: `left ${m[3]}, ${m[2]} days over` } : { name: w, detail: "" };
    });
    return { title: `${plural(workers.length || 1, "worker")} billed past their exit`, names };
  }
  if (check?.kind === "service_charge_base") return { title: "Service charge is on the wrong base", names: [] };
  return { title: f.message, names: [] };
}

interface Cut {
  line: InvoiceLine;
  qty: number;
  call: ToolCall;
}

/** Each flagged line brought down to the quantity the annexure supports. Lines the evidence cannot cut are skipped. */
function adjustToEvidence(draft: Draft, lineIds: string[], reason: string): Cut[] {
  const cuts: Cut[] = [];
  for (const id of lineIds) {
    const line = draft.invoice.lines.find((l) => l.line_id === id);
    if (!line) continue;
    const supported = supportedQuantity(line, draft.baseline as Invoice, draft.annexure as Annexure | null);
    if (!supported || supported.qty >= line.qty) continue;
    cuts.push({ line, qty: supported.qty, call: { tool: "adjust_line", line_id: id, field: "qty", value: supported.qty, reason } });
  }
  return cuts;
}

/** null when the agent has no fix to offer: the merchant can only waive the finding. */
export function proposeFor(item: ReportItem, rule: Rule | undefined, draft: Draft): Proposal | null {
  const check = rule?.check;
  if (!rule || !check) return null;
  const reason = `${rule.rule_id}: ${rule.rule}`.slice(0, 480);
  const { finding: f } = item;
  const { title } = describeFinding(item, rule);

  if (check.kind === "annexure_field_required_when") {
    const cuts = adjustToEvidence(draft, f.line_ids, reason);
    if (!cuts.length) return null;
    const removed = cuts.reduce((s, c) => s + (c.line.qty - c.qty), 0);
    const allZero = cuts.every((c) => c.qty === 0);
    return {
      calls: cuts.map((c) => c.call), title, keep: "Bill anyway",
      primary: allZero ? "Hold OT" : "Hold unauthorised OT",
      resolved: allZero ? "Overtime held pending authorisation" : "Unauthorised overtime held",
      note: `${removed} hours removed from ${compactLines(cuts.map((c) => c.line.line_id))}`,
    };
  }

  if (check.kind === "days_billed_capped_by_last_working_day") {
    const cuts = adjustToEvidence(draft, f.line_ids, reason);
    if (!cuts.length) return null;
    const removed = cuts.reduce((s, c) => s + (c.line.qty - c.qty), 0);
    const ids = compactLines(cuts.map((c) => c.line.line_id));
    const only = cuts.length === 1 ? ` (${cuts[0]!.line.qty} → ${cuts[0]!.qty})` : "";
    return {
      calls: cuts.map((c) => c.call), title, keep: "Keep",
      primary: "Bill to last working day",
      resolved: `${ids} billed to last working day`,
      note: `${removed} man-days removed${only}`,
    };
  }

  if (check.kind === "service_charge_base") {
    const wagesOnly = check.expected === "wages_only";
    return {
      calls: [{ tool: "set_service_charge_base", value: check.expected, reason }],
      title, keep: "Keep as is",
      primary: wagesOnly ? "Charge on wages only" : "Charge on wages and statutory",
      resolved: wagesOnly ? "Service charge moved to wages only" : "Service charge moved to wages and statutory",
      note: wagesOnly ? "Statutory contributions no longer carry the service charge" : "Statutory contributions now carry the service charge",
    };
  }

  return null;
}
