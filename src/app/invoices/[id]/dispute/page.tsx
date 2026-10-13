import { redirect } from "next/navigation";
import { getBuyer, getInvoice, loadDemoDispute, loadLedger } from "../../../../lib/data/load";
import { buildAnalysisView } from "../../../../lib/app/analysis_view";
import { listInvoices } from "../../../../lib/app/status";
import { AnalysisBoard } from "../../../components/AnalysisBoard";
import { InvoiceBar } from "../../../components/InvoiceBar";
import { PasteBox } from "../../../components/PasteBox";
import { hydrate } from "../../../../lib/data/remote_state";

export const dynamic = "force-dynamic";

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  await hydrate();
  const { id } = await params;
  const invoice = getInvoice(id);
  const buyer = getBuyer(invoice.buyer_id);
  const row = listInvoices().find((r) => r.invoice_id === id)!;
  if (row.chip === "paid_late") redirect(`/invoices/${id}`);
  const bar = { invoiceId: id, buyer: invoice.buyer_name, period: invoice.period_label, chip: row.chip };

  const view = buildAnalysisView(id);
  if (view) return <AnalysisBoard key={view.resolved?.dispute_id ?? "open"} view={view} bar={bar} />;

  const demo = loadDemoDispute();
  const sample = demo.includes(id) ? demo : null;
  const rules = loadLedger().filter((r) => r.buyer_id === buyer.id && r.status === "active").length;
  return (
    <>
      <InvoiceBar invoiceId={id} buyer={bar.buyer} period={bar.period} chip={bar.chip} />
      <main>
        <PasteBox invoiceId={id} buyer={buyer.short_name} rules={rules} lines={invoice.lines.length} sample={sample} draft={row.chip === "draft"} />
      </main>
    </>
  );
}
