import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Pre-send check", description: "Catch the dispute before the invoice goes out." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <span className="brand">Razorpay Invoices</span>
          <nav>
            <a className="on" href="/">Pre-send check</a>
            <span className="soon">Dispute analysis</span>
            <span className="soon">Rule ledger</span>
            <span className="soon">Disputes</span>
          </nav>
          <span className="who">Pragati Facility &amp; Manpower</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
