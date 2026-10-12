import type { ToolCall } from "../engine/tools";
import type { Check, Invoice, InvoiceLine, Rule } from "../schema";
import { shortDate } from "./format";

/**
 * What the invoice panel needs to show format fixes as a before/after, the way it already does for
 * quantities. Nothing here is computed by a model: "before" is the invoice as drafted or sent, "after" is the
 * invoice once the engine's own tools have run, and the difference is read straight off the two.
 */

/** The part of the invoice a format rule acts on. */
export type FormatFocus = "po" | "sac" | "group" | "window";

/** Per line: the PO and SAC as drafted and as fixed, and where the line sat before any regrouping. */
export interface FormatFields {
  po0: string | null;
  po1: string | null;
  sac0: string | null;
  sac1: string | null;
  /** Position in the invoice as drafted, to put the lines back in their role-wise order. */
  pos0: number;
}

export interface PanelHead {
  po: string;
  sac: string;
  /** "3 Nov 2026" */
  date: string;
  /** Only when the ledger holds a portal-window rule for this buyer. */
  window: { text: string; ok: boolean } | null;
}

/**
 * What a line shows once some format fixes are switched off: a fix that is off leaves the line as drafted.
 * `applied(focus)` says whether that fix is currently in force.
 */
export function shownFields(l: FormatFields, applied: (focus: FormatFocus) => boolean): { po: string | null; sac: string | null; poFixed: boolean; sacFixed: boolean } {
  const po = applied("po") ? l.po1 : l.po0;
  const sac = applied("sac") ? l.sac1 : l.sac0;
  return { po, sac, poFixed: applied("po") && l.po0 !== l.po1, sacFixed: applied("sac") && l.sac0 !== l.sac1 };
}

export function formatFields(original: Invoice, after: InvoiceLine): FormatFields {
  const at = original.lines.findIndex((l) => l.line_id === after.line_id);
  const was = original.lines[at] ?? after;
  return { po0: was.po_number ?? null, po1: after.po_number ?? null, sac0: was.sac ?? null, sac1: after.sac ?? null, pos0: Math.max(at, 0) };
}

/** Sites appear as unbroken runs: nothing is split across the invoice. */
export function isGroupedBySite(inv: Invoice): boolean {
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const l of inv.lines) {
    if (l.site_code !== previous && seen.has(l.site_code)) return false;
    seen.add(l.site_code);
    previous = l.site_code;
  }
  return true;
}

export function focusOfCheck(check: Check | undefined): FormatFocus | null {
  if (!check) return null;
  if (check.kind === "line_field_required" || check.kind === "line_field_matches")
    return check.field === "po_number" ? "po" : check.field === "sac" ? "sac" : null;
  if (check.kind === "lines_grouped_by") return "group";
  if (check.kind === "invoice_date_window") return "window";
  return null;
}

/** What a format tool call changes on the invoice. */
export function focusOfCall(call: ToolCall): FormatFocus | null {
  if (call.tool === "set_field") return call.field === "po_number" ? "po" : "sac";
  if (call.tool === "regroup_lines") return "group";
  return null;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/**
 * The header strip above the lines. The portal-window chip appears only when a rule enforcing it is in
 * play (`window` carries its days), so it shows up the moment the ledger learns the rule and goes with it.
 */
export function panelHead(invoice: Invoice, buyerShort: string, window: { from_day: number; to_day: number } | null): PanelHead {
  const day = Number(invoice.invoice_date.slice(8, 10));
  const ok = window ? day >= window.from_day && day <= window.to_day : true;
  const span = window ? `${ordinal(window.from_day)}–${ordinal(window.to_day)}` : "";
  return {
    po: invoice.po_number,
    sac: invoice.sac,
    date: shortDate(invoice.invoice_date, true),
    window: window
      ? { ok, text: ok ? `Inside ${buyerShort}'s ${span} portal window` : `Outside ${buyerShort}'s ${span} portal window` }
      : null,
  };
}

/** The portal-window rule that applies to this buyer, among the active rules. */
export function windowOf(buyerId: string, rules: Rule[]): { from_day: number; to_day: number } | null {
  for (const r of rules) {
    if (r.buyer_id === buyerId && r.status === "active" && r.check?.kind === "invoice_date_window")
      return { from_day: r.check.from_day, to_day: r.check.to_day };
  }
  return null;
}
