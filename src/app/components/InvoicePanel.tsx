import type { ReactNode } from "react";
import { inr } from "../../lib/app/format";
import type { TotalsView } from "../../lib/app/presend_view";
import type { Touch } from "./bits";

export interface PanelLine {
  line_id: string;
  description: string;
  site_name: string;
  site_full: string;
  unit: string;
  qty0: number;
  qty1: number;
  amount0: number;
  amount1: number;
}

const qty = (n: number, unit: string) => `${n.toLocaleString("en-IN")}${unit === "hours" ? " h" : ""}`;

function Pair({ before, after, show }: { before: string; after: string; show: boolean }) {
  return show ? (
    <>
      <span className="was">{before}</span>
      <span className="now">{after}</span>
    </>
  ) : (
    <>{after}</>
  );
}

interface Props {
  lines: PanelLine[];
  grouped: boolean;
  base: TotalsView;
  now: TotalsView;
  /** The lines the selected finding or claim touches. */
  touch: Touch;
  footer?: ReactNode;
  /** Overrides the header's right-hand label. */
  caption?: string;
}

/** The artefact the agent reasoned about. Selecting a finding on the left lights its lines here. */
export function InvoicePanel({ lines, grouped, base, now, touch, footer, caption }: Props) {
  const rows: ReactNode[] = [];
  let site: string | null = null;
  for (const l of lines) {
    if (grouped && l.site_full !== site) {
      site = l.site_full;
      rows.push(
        <tr className="grp" key={`g-${l.site_full}`}>
          <td colSpan={4}>{l.site_full}</td>
        </tr>,
      );
    }
    const changed = l.qty0 !== l.qty1;
    const lit = touch && (touch.all || touch.ids.has(l.line_id));
    const cls = [changed ? "cut" : "", lit ? (touch!.tone === "ochre" && !changed ? "flag" : "hl") : ""].filter(Boolean).join(" ");
    rows.push(
      <tr key={l.line_id} className={cls || undefined} data-line={l.line_id}>
        <td><span className="id">{l.line_id}</span></td>
        <td>{l.description}{!grouped && <span className="sub-site"> · {l.site_name}</span>}</td>
        <td className="r num"><Pair show={changed} before={qty(l.qty0, l.unit)} after={qty(l.qty1, l.unit)} /></td>
        <td className="r num"><Pair show={changed} before={inr(l.amount0)} after={inr(l.amount1)} /></td>
      </tr>,
    );
  }

  const moved = now.total !== base.total;
  return (
    <aside aria-label="Invoice">
      <header>
        <h3>Invoice</h3>
        <span>{caption ?? (grouped ? "grouped site-wise" : "as drafted")}</span>
      </header>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>#</th><th>Line</th><th className="r">Qty</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      <dl className="tot">
        <dt>Wages</dt>
        <dd className="num"><Pair show={now.wages !== base.wages} before={inr(base.wages)} after={inr(now.wages)} /></dd>
        <dt>Statutory and service charge</dt>
        <dd className="num"><Pair show={now.statutory !== base.statutory} before={inr(base.statutory)} after={inr(now.statutory)} /></dd>
        <dt>GST 18%</dt>
        <dd className="num"><Pair show={now.gst !== base.gst} before={inr(base.gst)} after={inr(now.gst)} /></dd>
        <dt className="g">Total</dt>
        <dd className={`g num${moved ? " moved" : ""}`}><Pair show={moved} before={inr(base.total)} after={inr(now.total)} /></dd>
      </dl>
      {footer && <footer>{footer}</footer>}
    </aside>
  );
}
