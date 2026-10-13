import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getInvoice, loadInvoices } from "../../../lib/data/load";
import { isDisputable } from "../../../lib/app/status";
import { InvoiceTabs } from "../../components/InvoiceBar";
import { hydrate } from "../../../lib/data/remote_state";

export default async function InvoiceLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  await hydrate();
  const { id } = await params;
  if (!loadInvoices().some((i) => i.invoice_id === id)) notFound();
  return (
    <>
      <InvoiceTabs id={id} disputable={isDisputable(id)} draft={getInvoice(id).status === "draft"} />
      {children}
    </>
  );
}
