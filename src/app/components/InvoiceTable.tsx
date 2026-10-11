"use client";

import Link from "next/link";
import { CHIP_LABEL, CHIP_TONE } from "../../lib/app/chips";
import { rupees, shortDate } from "../../lib/app/format";
import type { InvoiceRow } from "../../lib/app/status";
import { SortTh, useSort } from "./sort";

type Key = "invoice" | "buyer" | "period" | "dated" | "total";

export function InvoiceTable({ rows }: { rows: InvoiceRow[] }) {
  const { sorted, sort, toggle } = useSort<InvoiceRow, Key>(rows, {
    invoice: (r) => r.invoice_id,
    buyer: (r) => r.buyer_name,
    period: (r) => r.period_start,
    dated: (r) => r.invoice_date,
    total: (r) => r.total,
  });
  return (
    <div className="sheet">
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <SortTh label="Invoice" k="invoice" sort={sort} onSort={toggle} />
              <SortTh label="Buyer" k="buyer" sort={sort} onSort={toggle} />
              <SortTh label="Period" k="period" sort={sort} onSort={toggle} className="hide-s" />
              <SortTh label="Dated" k="dated" sort={sort} onSort={toggle} className="hide-s" />
              <SortTh label="Total" k="total" sort={sort} onSort={toggle} right />
              <th>Status</th>
              <th>Next</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.invoice_id}>
                <td><Link className="open" href={`/invoices/${r.invoice_id}`}>{r.invoice_id}</Link></td>
                <td>{r.buyer_name}</td>
                <td className="hide-s">{r.period_label}</td>
                <td className="hide-s num">{shortDate(r.invoice_date, true)}</td>
                <td className="r num">{rupees(r.total)}</td>
                <td><span className={`state ${CHIP_TONE[r.chip]}`}>{CHIP_LABEL[r.chip]}</span></td>
                <td className="next">
                  {r.open ? (
                    <Link href={`/invoices/${r.invoice_id}`}>{r.open} to decide</Link>
                  ) : r.needs_dispute ? (
                    <Link href={`/invoices/${r.invoice_id}/dispute`}>Review the dispute</Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
