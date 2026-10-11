"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CHIP_LABEL, CHIP_TONE, type Chip } from "../../lib/app/chips";

export function InvoiceTabs({ id }: { id: string }) {
  const path = usePathname();
  const dispute = path.endsWith("/dispute");
  return (
    <div className="tabs">
      <Link href={`/invoices/${id}`} aria-current={dispute ? undefined : "page"}>Pre-send check</Link>
      <Link href={`/invoices/${id}/dispute`} aria-current={dispute ? "page" : undefined}>Dispute analysis</Link>
    </div>
  );
}

export function StatusChip({ chip }: { chip: Chip }) {
  return <span className={`state ${CHIP_TONE[chip]}`}>{CHIP_LABEL[chip]}</span>;
}

interface BarProps {
  invoiceId: string;
  buyer: string;
  period: string;
  chip: Chip;
  children?: ReactNode;
}

/** The invoice's identity and the one thing to do next. */
export function InvoiceBar({ invoiceId, buyer, period, chip, children }: BarProps) {
  return (
    <div className="bar">
      <h1>{invoiceId}</h1>
      <span className="meta">{buyer}</span>
      <span className="meta">{period}</span>
      <StatusChip chip={chip} />
      {children && <div className="right">{children}</div>}
    </div>
  );
}
