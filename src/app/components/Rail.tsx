"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { resetDemo } from "../actions";
import type { RailCounts } from "../../lib/app/status";

interface Props {
  counts: RailCounts;
  agency: string;
  who: { name: string; role: string } | null;
}

export function Rail({ counts, agency, who }: Props) {
  const path = usePathname();
  const presendHref = counts.presendTarget ? `/invoices/${counts.presendTarget}` : "/";
  const items = [
    { href: "/", label: "All invoices", pill: counts.invoices, hot: false, on: path === "/" || (path.startsWith("/invoices/") && !path.endsWith(counts.presendTarget ?? "\0")) },
    { href: presendHref, label: "Pre-send check", pill: counts.presend || "✓", hot: counts.presend > 0, clear: counts.presend === 0, on: counts.presendTarget !== null && path === `/invoices/${counts.presendTarget}` },
    { href: "/disputes", label: "Disputes", pill: counts.disputes, hot: false, on: path.startsWith("/disputes") },
    { href: "/rules", label: "Buyer rules", pill: counts.rules, hot: false, on: path.startsWith("/rules") },
  ];

  return (
    <div className="rail">
      <Link href="/" className="mark">
        <b>Invoices<span>{agency}</span></b>
      </Link>
      <nav aria-label="Main">
        {items.map((i) => (
          <Link key={i.label} href={i.href} aria-current={i.on ? "page" : undefined}>
            <span>{i.label}</span>
            <span className={`pill num${i.hot ? " hot" : ""}${"clear" in i && i.clear ? " clear" : ""}`}>{i.pill}</span>
          </Link>
        ))}
      </nav>
      <div className="who">
        {who && <b>{who.name}</b>}
        {who?.role}
        <form action={resetDemo}>
          <button className="reset" type="submit">Reset demo data</button>
        </form>
      </div>
    </div>
  );
}
