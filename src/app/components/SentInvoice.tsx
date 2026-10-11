import Link from "next/link";
import { rupees, shortDate } from "../../lib/app/format";
import type { PresendView } from "../../lib/app/presend_view";
import type { Chip } from "../../lib/app/chips";
import { InvoicePanel } from "./InvoicePanel";

const HEADLINE: Record<Chip, (buyer: string) => string> = {
  draft: () => "",
  sent: (b) => `Sent to ${b}.`,
  disputed: (b) => `${b} has raised a dispute.`,
  revised: (b) => `Revised after ${b}'s dispute.`,
  paid_late: (b) => `Paid by ${b}, late.`,
};

const FLAG: Record<Chip, string> = { draft: "", sent: "SENT", disputed: "DISPUTED", revised: "REVISED", paid_late: "PAID LATE" };

interface Props {
  view: PresendView;
  chip: Chip;
  total: number;
  /** A dispute has been raised here and not decided. */
  raised: boolean;
  disputable: boolean;
}

/** An invoice that has gone out: what it says, and where to take a dispute. Nothing here is open work. */
export function SentInvoice({ view, chip, total, raised, disputable }: Props) {
  const tone = chip === "disputed" ? "attn" : "sent";
  return (
    <main>
      <div className={`verdict ${tone}`}>
        <div>
          <div className="flag">{FLAG[chip]}</div>
          <h2>{HEADLINE[chip](view.buyer_short)}</h2>
          <p className="sub">Dated {shortDate(view.invoice_date, true)}.</p>
          {disputable && (
            <Link className="btn pri go-link" href={`/invoices/${view.invoice_id}/dispute`} style={{ marginTop: 14 }}>
              {raised ? "Review the dispute" : chip === "revised" ? "See the dispute" : `Paste ${view.buyer_short}'s message`}
            </Link>
          )}
        </div>
        <div className="money">
          <b className="num">{rupees(total)}</b>
          <span>invoice total</span>
        </div>
      </div>
      <div style={{ maxWidth: 780 }}>
        <InvoicePanel lines={view.lines} grouped={view.grouped} base={view.base} now={view.base} touch={null} caption="as sent" />
      </div>
    </main>
  );
}
