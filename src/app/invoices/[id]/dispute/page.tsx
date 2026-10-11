import Link from "next/link";
import { getBuyer, getInvoice, loadDemoDispute, loadLedger } from "../../../../lib/data/load";
import { buildAnalysisView } from "../../../../lib/app/analysis_view";
import { listInvoices } from "../../../../lib/app/status";
import { AnalysisBoard } from "../../../components/AnalysisBoard";
import { InvoiceBar } from "../../../components/InvoiceBar";
import { PasteBox } from "../../../components/PasteBox";

export const dynamic = "force-dynamic";

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = getInvoice(id);
  const buyer = getBuyer(invoice.buyer_id);
  const row = listInvoices().find((r) => r.invoice_id === id)!;
  const bar = { invoiceId: id, buyer: invoice.buyer_name, period: invoice.period_label, chip: row.chip };

  // A draft has not gone out, so there is nothing to dispute yet.
  if (invoice.status === "draft" && row.chip === "draft") {
    return (
      <>
        <InvoiceBar invoiceId={id} buyer={bar.buyer} period={bar.period} chip={bar.chip} />
        <main>
          <div className="empty">
            <h2>Nothing to dispute yet.</h2>
            <p>This invoice has not gone out. The pre-send check is where {buyer.short_name}&apos;s known objections are caught.</p>
            <Link className="btn pri" href={`/invoices/${id}`}>Open the pre-send check</Link>
          </div>
        </main>
      </>
    );
  }

  const view = buildAnalysisView(id);
  if (view) return <AnalysisBoard key={view.resolved?.dispute_id ?? "open"} view={view} bar={bar} />;

  const demo = loadDemoDispute();
  const sample = demo.includes(id) ? demo : null;
  const rules = loadLedger().filter((r) => r.buyer_id === buyer.id && r.status === "active").length;
  return (
    <>
      <InvoiceBar invoiceId={id} buyer={bar.buyer} period={bar.period} chip={bar.chip} />
      <main>
        <PasteBox invoiceId={id} buyer={buyer.short_name} rules={rules} lines={invoice.lines.length} sample={sample} />
      </main>
    </>
  );
}
