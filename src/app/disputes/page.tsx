import { loadAllDisputes, loadBuyers, loadResolvedDisputes } from "../../lib/data/load";
import { plural, summarise } from "../../lib/app/format";
import { loadAnalysis } from "../../lib/app/store";
import { listInvoices } from "../../lib/app/status";
import { DisputeTable, type DisputeRow } from "../components/DisputeTable";
import { hydrate } from "../../lib/data/remote_state";

export const dynamic = "force-dynamic";

const isOpen = (resolution: string) => /^open\b/i.test(resolution.trim());

export default async function DisputesPage() {
  await hydrate();
  const buyers = new Map(loadBuyers().map((b) => [b.id, b.short_name]));
  const fresh = new Set(loadResolvedDisputes().map((d) => d.dispute_id));
  const all = [...loadAllDisputes()].sort((a, b) => b.received_at.localeCompare(a.received_at) || b.dispute_id.localeCompare(a.dispute_id));
  const days = all.reduce((s, d) => s + (d.days_delayed ?? 0), 0);

  // Past disputes. The history holds one record that was still open when it was written; it is not a live
  // dispute here, so it reads as a record with no outcome rather than as work to do.
  const rows: DisputeRow[] = all.map((d) => ({
    dispute_id: d.dispute_id,
    received_at: d.received_at,
    buyer: buyers.get(d.buyer_id) ?? d.buyer_id,
    invoice_id: d.invoice_id,
    buckets: d.buckets,
    open: false,
    fresh: fresh.has(d.dispute_id),
    summary: isOpen(d.resolution) ? "No outcome was recorded." : summarise(d.resolution),
    days_delayed: d.days_delayed,
    amount: d.amount_disputed,
  }));

  // Disputes raised here: a buyer's message has been read and nobody has decided yet. They come first.
  const raised: DisputeRow[] = listInvoices()
    .filter((i) => i.needs_dispute)
    .map((i) => {
      const claims = loadAnalysis(i.invoice_id)?.result.outcomes.length ?? 0;
      return {
        dispute_id: "",
        received_at: i.invoice_date,
        buyer: buyers.get(i.buyer_id) ?? i.buyer_name,
        invoice_id: i.invoice_id,
        buckets: [],
        open: true,
        fresh: false,
        summary: claims ? `${plural(claims, "claim")} read from the buyer's message, waiting for your decision.` : "The buyer's message held nothing to act on.",
        days_delayed: null,
        amount: 0,
        awaiting: true,
      };
    });
  rows.unshift(...raised);

  return (
    <>
      <div className="bar">
        <h1>Disputes</h1>
        <span className="meta">{plural(all.length, "dispute")}</span>
        <span className="meta num">{days} days of payment delayed</span>
      </div>
      <main>
        <DisputeTable rows={rows} />
      </main>
    </>
  );
}
