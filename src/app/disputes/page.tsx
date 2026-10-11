import { loadAllDisputes, loadBuyers, loadResolvedDisputes } from "../../lib/data/load";
import { plural } from "../../lib/app/format";
import { DisputeTable, type DisputeRow } from "../components/DisputeTable";

export const dynamic = "force-dynamic";

const isOpen = (resolution: string) => /^open\b/i.test(resolution.trim());
const clip = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

export default function DisputesPage() {
  const buyers = new Map(loadBuyers().map((b) => [b.id, b.short_name]));
  const fresh = new Set(loadResolvedDisputes().map((d) => d.dispute_id));
  const all = [...loadAllDisputes()].sort((a, b) => b.received_at.localeCompare(a.received_at) || b.dispute_id.localeCompare(a.dispute_id));
  const days = all.reduce((s, d) => s + (d.days_delayed ?? 0), 0);

  const rows: DisputeRow[] = all.map((d) => ({
    dispute_id: d.dispute_id,
    received_at: d.received_at,
    buyer: buyers.get(d.buyer_id) ?? d.buyer_id,
    invoice_id: d.invoice_id,
    buckets: d.buckets,
    open: isOpen(d.resolution),
    fresh: fresh.has(d.dispute_id),
    summary: clip(d.resolution),
    days_delayed: d.days_delayed,
    amount: d.amount_disputed,
  }));

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
