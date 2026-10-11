import { buildPresendView } from "../../../lib/app/presend_view";
import { listInvoices } from "../../../lib/app/status";
import { rupees } from "../../../lib/app/format";
import { InvoiceBar } from "../../components/InvoiceBar";
import { PresendBoard } from "../../components/PresendBoard";
import { SendButton } from "../../components/SendButton";

export const dynamic = "force-dynamic";

export default async function PresendPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = buildPresendView(id);
  const row = listInvoices().find((r) => r.invoice_id === id)!;
  const v = view.verdict;

  return (
    <>
      <InvoiceBar invoiceId={id} buyer={view.buyer_name} period={view.period_label} chip={row.chip}>
        {!view.read_only && <SendButton invoiceId={id} ready={view.sendable} />}
      </InvoiceBar>
      <main>
        <div className={`verdict ${v.tone}`}>
          <div>
            <div className="flag">{v.flag}</div>
            <h2>{v.say}</h2>
            <p className="sub">{v.sub}</p>
          </div>
          {v.money !== null && (
            <div className="money">
              <b className="num">{rupees(v.money)}</b>
              <span>{v.moneyNote}</span>
            </div>
          )}
        </div>
        <PresendBoard view={view} />
      </main>
    </>
  );
}
