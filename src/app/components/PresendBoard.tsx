"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { approveFinding, undoDecision, waiveFinding } from "../actions";
import { plural, rupees } from "../../lib/app/format";
import type { HandledView, NeedView, PresendView } from "../../lib/app/presend_view";
import { activate, Call, Id, Sources, type Touch } from "./bits";
import { InvoicePanel } from "./InvoicePanel";

type Key = string;
const needKey = (n: NeedView): Key => `need:${n.rule_id}`;

export function PresendBoard({ view }: { view: PresendView }) {
  const firstNeed = view.needs[0];
  const [selected, setSelected] = useState<Key | null>(firstNeed ? needKey(firstNeed) : null);
  const [open, setOpen] = useState<Key | null>(null);
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const toggleOpen = (key: Key) => setOpen((o) => (o === key ? null : key));

  // What the selection touches on the invoice.
  let touch: Touch = null;
  const need = view.needs.find((n) => needKey(n) === selected);
  const done = view.handled.find((h) => h.key === selected);
  if (need) touch = { ids: new Set(need.line_ids), all: need.line_ids.length === 0 && need.bucket === "format", tone: "ochre" };
  else if (done) touch = { ids: new Set("line_ids" in done ? done.line_ids : []), all: done.kind === "formats", tone: "teal" };

  const run = (id: string, work: () => Promise<{ ok: boolean; error?: string }>, after: () => void) => {
    setBusy(id);
    setError(null);
    startTransition(async () => {
      const r = await work();
      setBusy(null);
      if (!r.ok) setError(r.error ?? "That did not go through.");
      else after();
    });
  };

  const nextAfter = (ruleId: string, resolvedKey: Key) => () => {
    const rest = view.needs.filter((n) => n.rule_id !== ruleId);
    setSelected(rest[0] ? needKey(rest[0]) : resolvedKey);
    setOpen(null);
    setWaiving(null);
    setReason("");
  };

  const heldNote = view.held && (
    <>
      {rupees(view.held.wages)} of wages held took <b>{rupees(view.held.total)}</b> off the invoice, once statutory charges and GST followed.
    </>
  );

  return (
    <div className="cols">
      <div>
        {error && <div className="banner" role="alert"><p>{error}</p></div>}

        {view.needs.length > 0 && <p className="lbl">Needs you</p>}
        {view.needs.map((n) => {
          const key = needKey(n);
          const on = selected === key;
          const working = busy === n.rule_id;
          return (
            <article key={key} className={`find${on ? " on" : ""}`}>
              <div
                className="row" role="button" tabIndex={0} aria-pressed={on}
                onClick={() => setSelected(key)} onKeyDown={activate(() => setSelected(key))}
              >
                <div>
                  <div className="what">{n.title}</div>
                  <div className="where">
                    {n.line_ids.length > 0 && n.line_ids.length <= 6
                      ? n.line_ids.map((l) => <Id key={l}>{l}</Id>)
                      : n.where && <Id>{n.where}</Id>}
                    {n.bucket === "format" && <span>Needs a person to fix</span>}
                  </div>
                </div>
                {n.amount !== null && (
                  <div className="amt num">
                    {rupees(n.amount)}
                    <em>Potential Issue</em>
                  </div>
                )}
              </div>

              {n.stale?.may_be_out_of_date && (
                <p className="stale">
                  Waived on {n.stale.overridden_on.join(", ")}.{" "}
                  <Link href={`/rules#${n.rule_id}`}>The rule may be out of date</Link>
                </p>
              )}
              {n.reopened && <p className="stale">You waived this before, but the invoice has changed since. It needs another look.</p>}

              {!view.read_only && (
                <div className="act">
                  {n.primary && (
                    <button
                      className="btn pri" disabled={working}
                      onClick={() => run(n.rule_id, () => approveFinding(view.invoice_id, n.rule_id), nextAfter(n.rule_id, `approved:${n.rule_id}`))}
                    >
                      {n.primary}
                    </button>
                  )}
                  {n.keep && (
                    <button
                      className="btn" disabled={working} aria-expanded={waiving === n.rule_id}
                      onClick={() => { setWaiving(waiving === n.rule_id ? null : n.rule_id); setReason(""); setSelected(key); }}
                    >
                      {n.keep}
                    </button>
                  )}
                  <button className="why" aria-expanded={open === key} onClick={() => toggleOpen(key)}>why</button>
                </div>
              )}
              {view.read_only && (
                <div className="act"><button className="why" aria-expanded={open === key} onClick={() => toggleOpen(key)}>why</button></div>
              )}

              {waiving === n.rule_id && (
                <form
                  className="inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(n.rule_id, () => waiveFinding(view.invoice_id, n.rule_id, reason), nextAfter(n.rule_id, `waived:${n.rule_id}`));
                  }}
                >
                  <label className="sr" htmlFor={`why-${n.rule_id}`}>Why is this fine on this invoice?</label>
                  <input
                    id={`why-${n.rule_id}`} className="field" autoFocus value={reason} maxLength={300}
                    placeholder="Why is this fine? (optional)" onChange={(e) => setReason(e.target.value)}
                  />
                  <button className="btn pri" type="submit" disabled={working}>Waive for this invoice</button>
                  <button className="btn" type="button" onClick={() => setWaiving(null)}>Cancel</button>
                </form>
              )}

              <div className="more" hidden={open !== key}>
                <Call calls={n.calls} />
                {n.names.length > 0 && (
                  <ul className="names">
                    {n.names.map((w) => (
                      <li key={w.name}><span className="n">{w.name}</span><span className="d num">{w.detail}</span></li>
                    ))}
                  </ul>
                )}
                <p className="rule">{n.rule}</p>
                <p className="from">
                  Learned from <Sources sources={n.sources} /> · rule <Id>{n.rule_id}</Id> · seen {plural(n.corroborated, "time")}, {n.confidence} confidence
                </p>
              </div>
            </article>
          );
        })}

        {view.handled.length > 0 && <p className="lbl f">Already handled</p>}
        {view.handled.map((h) => (
          <HandledRow
            key={h.key} h={h} on={selected === h.key} open={open === h.key}
            busy={busy === (("rule_id" in h && h.rule_id) || h.key)}
            onSelect={() => setSelected(h.key)}
            onToggle={() => toggleOpen(h.key)}
            onUndo={() => {
              if (!("rule_id" in h)) return;
              run(h.rule_id, () => undoDecision(view.invoice_id, h.rule_id).then((r) => ({ ok: r.ok })), () => {
                const first = view.needs[0];
                setSelected(first ? needKey(first) : null);
              });
            }}
          />
        ))}

        <p className="quiet">
          {view.passed.length > 0 && (
            <>
              {plural(view.passed.length, "other check")} passed.{" "}
              <button className="link" aria-expanded={open === "passed"} onClick={() => toggleOpen("passed")}>See {view.passed.length === 1 ? "it" : "them"}</button>
            </>
          )}
          {view.manual.length > 0 && (
            <>
              {view.passed.length > 0 && " "}
              {plural(view.manual.length, "rule")} can only be checked by a person.{" "}
              <button className="link" aria-expanded={open === "manual"} onClick={() => toggleOpen("manual")}>See {view.manual.length === 1 ? "it" : "them"}</button>
            </>
          )}
        </p>
        {view.passed.length > 0 && (
          <div className="more" hidden={open !== "passed"}>
            <ul className="plain">{view.passed.map((p) => <li key={p.rule_id}><Id>{p.rule_id}</Id> {p.text}</li>)}</ul>
          </div>
        )}
        {view.manual.length > 0 && (
          <div className="more" hidden={open !== "manual"}>
            <ul className="plain">{view.manual.map((m) => <li key={m.rule_id}><Id>{m.rule_id}</Id> {m.text}<br /><span className="from">{m.note}</span></li>)}</ul>
          </div>
        )}
      </div>

      <InvoicePanel
        lines={view.lines} grouped={view.grouped} base={view.base} now={view.now} touch={touch}
        footer={heldNote}
      />
    </div>
  );
}

function HandledRow({
  h, on, open, busy, onSelect, onToggle, onUndo,
}: {
  h: HandledView; on: boolean; open: boolean; busy: boolean;
  onSelect: () => void; onToggle: () => void; onUndo: () => void;
}) {
  const stale = h.kind === "waived" ? h.stale : null;
  return (
    <div className={`done${on ? " on" : ""}${h.kind === "waived" ? " set-aside" : ""}`}>
      <div className="row" onClick={onSelect}>
        <span className="tick" aria-hidden="true">{h.kind === "waived" ? "–" : "✓"}</span>
        <div className="what" role="button" tabIndex={0} aria-pressed={on} onKeyDown={activate(onSelect)}>
          {h.heading}
          <i>
            {h.note}
            {stale?.may_be_out_of_date && (
              <> · waived on {stale.overridden_on.length} invoices, <Link href={`/rules#${h.kind === "waived" ? h.rule_id : ""}`}>the rule may be out of date</Link></>
            )}
          </i>
        </div>
        {h.kind === "approved" && <span className="cut num">−{rupees(h.cut)}</span>}
        {h.kind === "formats" && (
          <button className="why" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }}>what</button>
        )}
        {h.kind !== "formats" && h.undo && (
          <button className="link" disabled={busy} onClick={(e) => { e.stopPropagation(); onUndo(); }}>Undo</button>
        )}
      </div>
      {h.kind === "formats" && (
        <div className="more" hidden={!open}>
          <ul>
            {h.fixes.map((f) => (
              <li key={f.rule_id}>
                {f.text} · <Id>{f.rule_id}</Id>, from <Sources sources={f.sources} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

