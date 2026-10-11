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
  /** A dispute has been raised here and not yet decided. */
  needs_dispute: boolean;
}

export function listInvoices(): InvoiceRow[] {
  const records = loadAllRecords();
  return loadInvoices().map((inv) => {
    const stored = loadAnalysis(inv.invoice_id);
    const resolved = stored?.resolved;
    // A dispute exists once a buyer's message has been read here and not yet decided. The dataset's own
    // "disputed" / "short_paid" labels do not start one: until a message is pasted, the invoice is just sent.
    const raised = Boolean(stored && !stored.resolved);
    const sentAt = records[inv.invoice_id]?.sent_at;
    const base: Chip = inv.status === "disputed" || inv.status === "short_paid" ? "sent" : (inv.status as Chip);
    const chip: Chip = sentAt ? "sent" : resolved ? "revised" : raised && inv.status !== "draft" ? "disputed" : base;
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
      needs_dispute: raised,
    };
  });
}

export interface RailCounts {
  invoices: number;
  /** Decisions waiting across every unsent draft. */
  presend: number;
  /** Disputes raised here and not yet decided. */
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

/** A paid invoice is a closed chapter: there is nothing left to dispute. */
export function isDisputable(invoiceId: string): boolean {
  return listInvoices().find((r) => r.invoice_id === invoiceId)?.chip !== "paid_late";
}
