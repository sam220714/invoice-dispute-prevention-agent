import { listInvoices } from "../lib/app/status";
import { InvoiceTable } from "./components/InvoiceTable";

export const dynamic = "force-dynamic";

export default function InvoicesPage() {
  const rows = listInvoices();
  return (
    <>
      <div className="bar">
        <h1>All invoices</h1>
        <span className="meta">{rows.length} invoices</span>
      </div>
      <main>
        <InvoiceTable rows={rows} />
      </main>
    </>
  );
}
