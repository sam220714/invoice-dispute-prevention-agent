"use client";

import { useState } from "react";
import { plural } from "../../lib/app/format";
import type { Source } from "../../lib/app/presend_view";
import { Id, Sources } from "./bits";
import { RuleSwitch } from "./RuleSwitch";

export interface RuleData {
  rule_id: string;
  buyer_id: string;
  type: "business" | "format";
  text: string;
  active: boolean;
  sources: Source[];
  confidence: string;
  times: number;
  fresh: boolean;
  again: boolean;
  stale_note: string | null;
}

export interface BuyerData {
  id: string;
  name: string;
  short: string;
}

type Status = "all" | "active" | "inactive";

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="filter" role="group" aria-label={label}>
      <span className="filter-label">{label}</span>
      {options.map((o) => (
        <button key={o.id} type="button" className="chip" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function RulesBoard({ rules, buyers }: { rules: RuleData[]; buyers: BuyerData[] }) {
  const [buyer, setBuyer] = useState<string>("all");
  const [status, setStatus] = useState<Status>("all");

  const shown = rules.filter(
    (r) => (buyer === "all" || r.buyer_id === buyer) && (status === "all" || (status === "active") === r.active),
  );

  return (
    <>
      <div className="filters">
        <Choice
          label="Buyer" value={buyer} onChange={setBuyer}
          options={[{ id: "all", label: "All" }, ...buyers.map((b) => ({ id: b.id, label: b.short }))]}
        />
        <Choice
          label="Status" value={status} onChange={setStatus}
          options={[{ id: "all", label: "All" }, { id: "active", label: "Active" }, { id: "inactive", label: "Inactive" }]}
        />
      </div>

      {shown.length === 0 && (
        <div className="empty">
          <h2>No rules match.</h2>
          <p>Nothing is {status === "all" ? "" : `${status} `}for {buyer === "all" ? "any buyer" : buyers.find((b) => b.id === buyer)?.short}.</p>
          <button className="btn" onClick={() => { setBuyer("all"); setStatus("all"); }}>Show every rule</button>
        </div>
      )}

      {buyers.map((b) => {
        const mine = shown.filter((r) => r.buyer_id === b.id);
        if (!mine.length) return null;
        return (
          <section key={b.id}>
            <div className="buyer-h">
              <h2>{b.name}</h2>
              <span>{plural(mine.length, "rule")}</span>
            </div>
            {mine.map((r) => (
              <div key={r.rule_id} id={r.rule_id} className={`rule-row ${r.type === "business" ? "biz" : ""}${r.active ? "" : " off"}${r.fresh ? " fresh" : ""}`}>
                <div className="text-r">{r.text}</div>
                <RuleSwitch ruleId={r.rule_id} active={r.active} label="Check this rule" />
                <div className="meta">
                  <Id>{r.rule_id}</Id>
                  <span className={`tag ${r.type === "business" ? "biz" : "fmt"}`}>{r.type === "business" ? "Business" : "Format"}</span>
                  <span>Learned from <Sources sources={r.sources} /></span>
                  <span>{r.confidence} confidence · seen {plural(r.times, "time")}</span>
                  {r.fresh && <span className="seen new">Just Learned</span>}
                  {r.again && <span className="seen new">Confirmed Again</span>}
                  {r.stale_note && <span className="stale-note">{r.stale_note}</span>}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
