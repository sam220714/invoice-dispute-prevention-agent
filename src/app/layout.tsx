import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { loadAgency } from "../lib/data/load";
import { railCounts } from "../lib/app/status";
import { Rail } from "./components/Rail";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Razorpay · Invoices",
  description: "Catch the dispute before the invoice goes out.",
};

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export default function RootLayout({ children }: { children: ReactNode }) {
  const counts = railCounts();
  const agency = loadAgency();
  const biller = agency.team.find((t) => /billing/i.test(t.role)) ?? agency.team[0];
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="app">
          <Rail counts={counts} agency={agency.short_name} who={biller ? { name: biller.name, role: biller.role } : null} />
          <div className="stage">{children}</div>
        </div>
      </body>
    </html>
  );
}
