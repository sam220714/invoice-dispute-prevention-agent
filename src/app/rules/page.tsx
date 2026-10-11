import Link from "next/link";
import { loadAllDisputes, loadBuyers, loadLedger, loadOverrides, loadResolvedDisputes } from "../../lib/data/load";
import { staleSignal } from "../../lib/engine/overrides";
import { shortDate } from "../../lib/app/format";
import { RulesBoard, type RuleData } from "../components/RulesBoard";

export const dynamic = "force-dynamic";

const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 } as const;

export default function RulesPage() {
  const rules = loadLedger();
  const buyers = loadBuyers();
  const overrides = loadOverrides();
  const dates = new Map(loadAllDisputes().map((d) => [d.dispute_id, d.received_at]));
  const fresh = new Set(loadResolvedDisputes().map((d) => d.dispute_id));
  const active = rules.filter((r) => r.status === "active").length;

  const data: RuleData[] = [...rules]
    .sort((x, y) => CONFIDENCE_ORDER[x.confidence] - CONFIDENCE_ORDER[y.confidence] || x.rule_id.localeCompare(y.rule_id, "en", { numeric: true }))
    .map((r) => {
      const stale = staleSignal(overrides, r.rule_id);
      const isNew = r.learned_from.every((d) => fresh.has(d));
      const reason = stale?.last_reason;
      return {
        rule_id: r.rule_id,
        buyer_id: r.buyer_id,
        type: r.type,
        text: r.rule,
        active: r.status === "active",
        sources: r.learned_from.map((id) => ({ id, date: dates.has(id) ? shortDate(dates.get(id)!) : null })),
        confidence: r.confidence,
        times: r.times_corroborated,
        fresh: isNew,
        again: !isNew && r.learned_from.some((d) => fresh.has(d)),
        stale_note: stale?.may_be_out_of_date
          ? `Waived on ${stale.overridden_on.length} invoices${reason ? `, last time because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ""}. It may be out of date.`
          : null,
      };
    });

  return (
    <>
      <div className="bar">
        <h1>Buyer rules</h1>
        <span className="meta">{active} of {rules.length} switched on</span>
      </div>
      <main>
        <RulesBoard
          rules={data}
          buyers={buyers.filter((b) => rules.some((r) => r.buyer_id === b.id)).map((b) => ({ id: b.id, name: b.legal_name, short: b.short_name }))}
        />
        <p className="quiet">
          A rule that is switched off is not checked on new invoices and is not shown to the agent. Waiving a finding on one invoice never changes a rule.{" "}
          <Link href="/disputes">See the disputes they came from</Link>.
        </p>
      </main>
    </>
  );
}
