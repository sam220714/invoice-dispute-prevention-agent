"use client";

import Link from "next/link";
import { rupees, shortDate } from "../../lib/app/format";
import { SortTh, useSort } from "./sort";

export interface DisputeRow {
  dispute_id: string;
  received_at: string;
  buyer: string;
  invoice_id: string;
  buckets: string[];
  open: boolean;
  fresh: boolean;
  summary: string;
  days_delayed: number | null;
  amount: number;
}

type Key = "dispute" | "days" | "amount";

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function DisputeTable({ rows }: { rows: DisputeRow[] }) {
  const { sorted, sort, toggle } = useSort<DisputeRow, Key>(rows, {
    dispute: (r) => r.dispute_id,
    days: (r) => r.days_delayed ?? -1,
    amount: (r) => r.amount,
  });
  return (
    <div className="sheet">
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <SortTh label="Dispute" k="dispute" sort={sort} onSort={toggle} />
              <th>Buyer</th>
              <th>Brief summary of what happened</th>
              <SortTh label="Days held up" k="days" sort={sort} onSort={toggle} right className="hide-s" />
              <SortTh label="Disputed amount" k="amount" sort={sort} onSort={toggle} right className="hide-s" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.dispute_id}>
                <td>
                  <span className="id">{d.dispute_id}</span>
                  <span className="sub">{shortDate(d.received_at, true)}</span>
                </td>
                <td>
                  {d.buyer}
                  <span className="sub">
                    <Link href={`/invoices/${d.invoice_id}`}><span className="id">{d.invoice_id}</span></Link>
                  </span>
                </td>
                <td>
                  {d.buckets.map((b) => <span key={b} className={`tag ${b === "business" ? "biz" : "fmt"}`} style={{ marginRight: 6 }}>{title(b)}</span>)}
                  {d.open && <span className="state hold" style={{ marginRight: 6 }}>Open</span>}
                  {d.fresh && <span className="state done" style={{ marginRight: 6 }}>Resolved here</span>}
                  <span className="sub" style={{ marginTop: 4 }}>{d.summary}</span>
                </td>
                <td className="r num hide-s">{d.days_delayed ?? "–"}</td>
                <td className="r num hide-s">{d.amount ? rupees(d.amount) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
