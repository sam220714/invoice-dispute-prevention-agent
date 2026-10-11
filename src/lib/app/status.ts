import { loadInvoices, loadLedger } from "../data/load";
import { CHIP_LABEL, CHIP_TONE, type Chip } from "./chips";
import { openDecisions } from "./presend_view";
import { loadAllRecords, loadAnalysis } from "./store";

/**
 * Where each invoice stands, including what happened to it in this app: sent from the pre-send check,
 * or revised after a dispute was resolved. The dataset says how it started; the records say what changed.
 */

export { CHIP_LABEL, CHIP_TONE, type Chip };

export interface InvoiceRow {
  invoice_id: string;
  buyer_id: string;
  buyer_name: string;
  period_label: string;
  period_start: string;
  invoice_date: string;
  chip: Chip;
  total: number;
  /** A draft with decisions still open. */
  open: number | null;
  /** In dispute and not yet resolved here. */
  needs_dispute: boolean;
}

export function listInvoices(): InvoiceRow[] {
  const records = loadAllRecords();
  return loadInvoices().map((inv) => {
    const resolved = loadAnalysis(inv.invoice_id)?.resolved;
    const sentAt = records[inv.invoice_id]?.sent_at;
    const chip: Chip = sentAt ? "sent" : resolved ? "revised" : (inv.status as Chip);
    return {
      invoice_id: inv.invoice_id,
      buyer_id: inv.buyer_id,
      buyer_name: inv.buyer_name,
      period_label: inv.period_label,
      period_start: inv.period_start,
      invoice_date: inv.invoice_date,
      chip: chip in CHIP_LABEL ? chip : "paid_late",
      total: sentAt ? (records[inv.invoice_id]!.sent_total ?? inv.totals.grand_total) : resolved ? resolved.revised_total : inv.totals.grand_total,
      open: inv.status === "draft" && !sentAt ? openDecisions(inv.invoice_id) : null,
      needs_dispute: !resolved && (inv.status === "disputed" || inv.status === "short_paid"),
    };
  });
}

export interface RailCounts {
  invoices: number;
  /** Decisions waiting across every unsent draft. */
  presend: number;
  /** Invoices in dispute that nobody has resolved yet. */
  disputes: number;
  rules: number;
  /** The first draft with something open (else the first draft), where the Pre-send link goes. */
  presendTarget: string | null;
}

export function railCounts(): RailCounts {
  const rows = listInvoices();
  const drafts = rows.filter((r) => r.open !== null);
  return {
    invoices: rows.length,
    presend: drafts.reduce((s, r) => s + (r.open ?? 0), 0),
    disputes: rows.filter((r) => r.needs_dispute).length,
    rules: loadLedger().filter((r) => r.status === "active").length,
    presendTarget: (drafts.find((r) => (r.open ?? 0) > 0) ?? drafts[0])?.invoice_id ?? null,
  };
}
