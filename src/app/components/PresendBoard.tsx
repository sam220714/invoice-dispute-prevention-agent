"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { approveFinding, setFormatFix, undoDecision, waiveFinding } from "../actions";
import { plural, rupees } from "../../lib/app/format";
import type { HandledView, NeedView, PresendView } from "../../lib/app/presend_view";
import { activate, Id, type Touch } from "./bits";
import { InvoicePanel, type Focus } from "./InvoicePanel";
import type { FormatFocus } from "../../lib/app/panel";

type Key = string;
const needKey = (n: NeedView): Key => `need:${n.rule_id}`;

export function PresendBoard({ view }: { view: PresendView }) {
  const firstNeed = view.needs[0];
  const [selected, setSelected] = useState<Key | null>(firstNeed ? needKey(firstNeed) : null);
  // The format fixes the agent made on its own are the point of the screen, so they start open.
  const [open, setOpen] = useState<Key | null>(!view.read_only && view.handled.some((h) => h.kind === "formats") ? "formats" : null);
  const [fixFocus, setFixFocus] = useState<FormatFocus | null>(null);
  // A fix switch shows its new state at once; the server's answer follows. Dropped again only if the server refuses.
  const [fixOn, setFixOn] = useState<Record<string, boolean>>({});
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The parts of the invoice whose fix is switched off, as the screen shows it now (before the server catches up).
  const offFocus = view.handled.flatMap((h) => (h.kind === "formats" ? h.fixes : [])).flatMap((f) => ((fixOn[f.rule_id] ?? f.on) || !f.focus ? [] : [f.focus]));

  const toggleOpen = (key: Key) => setOpen((o) => (o === key ? null : key));

  // What the selection touches on the invoice.
  let touch: Touch = null;
  const need = view.needs.find((n) => needKey(n) === selected);
  const done = view.handled.find((h) => h.key === selected);
  if (need) touch = { ids: new Set(need.line_ids), all: need.line_ids.length === 0 && need.bucket === "format", tone: "ochre" };
  else if (done) touch = { ids: new Set("line_ids" in done ? done.line_ids : []), all: false, tone: "teal" };
  // A format fix lights what it changed on the invoice: one fix when it is picked, all of them for the row.
  const focus: Focus = done?.kind === "formats" ? (fixFocus ?? "all") : null;

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
                  <button className="why" aria-expanded={open === key} onClick={() => toggleOpen(key)}>Why</button>
                </div>
              )}
              {view.read_only && (
                <div className="act"><button className="why" aria-expanded={open === key} onClick={() => toggleOpen(key)}>Why</button></div>
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
                {n.names.length > 0 && (
                  <ul className="names">
                    {n.names.map((w) => (
                      <li key={w.name}><span className="n">{w.name}</span><span className="d num">{w.detail}</span></li>
                    ))}
                  </ul>
                )}
                <p className="rule">{n.rule}</p>
                <p className="from">
                  Learned from <Id>{n.rule_id}</Id>
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
            onSelect={() => { setSelected(h.key); setFixFocus(null); }}
            onFix={(f) => { setSelected(h.key); setFixFocus(f); }}
            fixFocus={selected === h.key ? fixFocus : null}
            readOnly={view.read_only}
            fixOn={fixOn}
            onToggleFix={(ruleId, on) => {
              setFixOn((m) => ({ ...m, [ruleId]: on }));
              run(`fix:${ruleId}`, async () => {
                const r = await setFormatFix(view.invoice_id, ruleId, on);
                if (!r.ok) setFixOn((m) => { const n = { ...m }; delete n[ruleId]; return n; });
                return r;
              }, () => {});
            }}
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
        lines={view.lines} grouped={view.grouped} grouped0={view.grouped0} head={view.head} focus={focus} off={offFocus}
        base={view.base} now={view.now} touch={touch} footer={heldNote}
      />
    </div>
  );
}

function HandledRow({
  h, on, open, busy, fixFocus, readOnly, fixOn, onSelect, onFix, onToggleFix, onToggle, onUndo,
}: {
  h: HandledView; on: boolean; open: boolean; busy: boolean; fixFocus: FormatFocus | null;
  readOnly: boolean; fixOn: Record<string, boolean>;
  onSelect: () => void; onFix: (focus: FormatFocus | null) => void; onToggleFix: (ruleId: string, on: boolean) => void;
  onToggle: () => void; onUndo: () => void;
}) {
  const stale = h.kind === "waived" ? h.stale : null;
  // The heading counts the fixes that are on right now, including a switch the server has not yet answered.
  const heading =
    h.kind === "formats" && !readOnly && h.fixes.some((f) => !(fixOn[f.rule_id] ?? f.on))
      ? `${h.fixes.filter((f) => fixOn[f.rule_id] ?? f.on).length} of ${plural(h.fixes.length, "format fix", "format fixes")} applied`
      : h.kind === "formats" && !readOnly
        ? `${plural(h.fixes.length, "format fix", "format fixes")} applied`
        : h.heading;
  return (
    <div className={`done${on ? " on" : ""}${h.kind === "waived" ? " set-aside" : ""}`}>
      <div className="row" onClick={onSelect}>
        <span className="tick" aria-hidden="true">{h.kind === "waived" ? "–" : "✓"}</span>
        <div className="what" role="button" tabIndex={0} aria-pressed={on} onKeyDown={activate(onSelect)}>
          {heading}
          <i>
            {h.note}
            {stale?.may_be_out_of_date && (
              <> · waived on {stale.overridden_on.length} invoices, <Link href={`/rules#${h.kind === "waived" ? h.rule_id : ""}`}>the rule may be out of date</Link></>
            )}
          </i>
        </div>
        {h.kind === "approved" && <span className="cut num">−{rupees(h.cut)}</span>}
        {h.kind === "formats" && (
          <button className="why" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }}>What</button>
        )}
        {h.kind !== "formats" && h.undo && (
          <button className="link" disabled={busy} onClick={(e) => { e.stopPropagation(); onUndo(); }}>Undo</button>
        )}
      </div>
      {h.kind === "formats" && (
        <div className="more" hidden={!open}>
          <ul className="fixes">
            {h.fixes.map((fix) => {
              const f = { ...fix, on: fixOn[fix.rule_id] ?? fix.on };
              return (
              <li key={f.rule_id} className={f.on ? undefined : "off"}>
                <input
                  type="checkbox" checked={f.on} disabled={readOnly}
                  aria-label={`Apply: ${f.text}`}
                  onChange={(e) => onToggleFix(f.rule_id, e.target.checked)}
                />
                <span>
                  <button
                    type="button" className="fixlink" aria-pressed={fixFocus !== null && fixFocus === f.focus}
                    onClick={(e) => { e.stopPropagation(); onFix(f.focus); }}
                  >
                    {f.text}
                  </button>{" "}
                  · <Id>{f.rule_id}</Id>
                  {!f.on && <em> · Not applied to this invoice</em>}
                </span>
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

