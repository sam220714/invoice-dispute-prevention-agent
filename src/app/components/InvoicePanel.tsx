"use client";

import { useState, type ReactNode } from "react";
import { inr } from "../../lib/app/format";
import { shownFields, type FormatFields, type FormatFocus, type PanelHead } from "../../lib/app/panel";
import type { TotalsView } from "../../lib/app/presend_view";
import type { Touch } from "./bits";

export interface PanelLine extends FormatFields {
  line_id: string;
  description: string;
  site_name: string;
  site_full: string;
  unit: string;
  qty0: number;
  qty1: number;
  amount0: number;
  amount1: number;
}

/** What to light: one part of the invoice, or everything a format fix changed. */
export type Focus = FormatFocus | "all" | null;

const qty = (n: number, unit: string) => `${n.toLocaleString("en-IN")}${unit === "hours" ? " h" : ""}`;

function Pair({ before, after, show }: { before: string; after: string; show: boolean }) {
  return show ? (
    <>
      <span className="was">{before}</span>
      <span className="now">{after}</span>
    </>
  ) : (
    <>{after}</>
  );
}

/** A PO or SAC value on a line: amber and dashed while missing, teal once the agent has filled it in. */
function Field({ label, value, fixed, lit }: { label: string; value: string | null; fixed: boolean; lit: boolean }) {
  const cls = ["fm", value === null ? "missing" : "", fixed ? "fixed" : "", lit ? "hl" : ""].filter(Boolean).join(" ");
  return <span className={cls}>{label} {value ?? "—"}</span>;
}

interface Props {
  lines: PanelLine[];
  /** The lines are grouped by site once the format fixes have run. */
  grouped: boolean;
  /** The lines were grouped by site as drafted. Defaults to the same as `grouped`: nothing regrouped. */
  grouped0?: boolean;
  head?: PanelHead;
  focus?: Focus;
  /** Format fixes the merchant has switched off: those parts of the invoice stay as drafted. */
  off?: FormatFocus[];
  /** Names for the two views of the invoice: as drafted (or sent), and after the format fixes. */
  labels?: [string, string];
  base: TotalsView;
  now: TotalsView;
  /** The lines the selected finding or claim touches. */
  touch: Touch;
  footer?: ReactNode;
  /** Overrides the header's right-hand label when there is no format change to switch between. */
  caption?: string;
}

/** The artefact the agent reasoned about. Selecting a finding on the left lights what it touches here. */
export function InvoicePanel({ lines, grouped, grouped0 = grouped, head, focus = null, off = [], labels = ["As drafted", "Fixed"], base, now, touch, footer, caption }: Props) {
  const [mode, setMode] = useState<"fixed" | "drafted">("fixed");

  const poChanged = lines.some((l) => l.po0 !== l.po1);
  const sacChanged = lines.some((l) => l.sac0 !== l.sac1);
  const groupChanged = grouped0 !== grouped;
  const hasFormat = poChanged || sacChanged || groupChanged;
  // The switch is a view, not an undo: format fixes are never taken back, only looked at as they were.
  const drafted = hasFormat && mode === "drafted";

  const lit = (f: FormatFocus) => focus === f || (focus === "all" && ({ po: poChanged, sac: sacChanged, group: groupChanged, window: false } as Record<FormatFocus, boolean>)[f]);

  // What is in force: nothing while viewing the draft as it started, otherwise every fix not switched off.
  const applied = (f: FormatFocus) => !drafted && !off.includes(f);
  const shown = applied("group") ? lines : [...lines].sort((a, b) => a.pos0 - b.pos0);
  const isGrouped = applied("group") ? grouped : grouped0;

  const rows: ReactNode[] = [];
  let site: string | null = null;
  for (const l of shown) {
    if (isGrouped && l.site_full !== site) {
      site = l.site_full;
      const cls = ["grp", applied("group") && groupChanged ? "fixed" : "", lit("group") ? "hl" : ""].filter(Boolean).join(" ");
      rows.push(
        <tr className={cls} key={`g-${l.site_full}`}>
          <td colSpan={4}>{l.site_full}</td>
        </tr>,
      );
    }
    const changed = l.qty0 !== l.qty1;
    const touched = touch && (touch.all || touch.ids.has(l.line_id));
    const cls = [changed ? "cut" : "", touched ? (touch!.tone === "ochre" && !changed ? "flag" : "hl") : ""].filter(Boolean).join(" ");
    const f = shownFields(l, applied);
    rows.push(
      <tr key={l.line_id} className={cls || undefined} data-line={l.line_id}>
        <td><span className="id">{l.line_id}</span></td>
        <td>
          {l.description}{!isGrouped && <span className="sub-site"> · {l.site_name}</span>}
          <div className="fm-row">
            <Field label="PO" value={f.po} fixed={f.poFixed} lit={lit("po")} />
            <Field label="SAC" value={f.sac} fixed={f.sacFixed} lit={lit("sac")} />
          </div>
        </td>
        <td className="r num"><Pair show={changed} before={qty(l.qty0, l.unit)} after={qty(l.qty1, l.unit)} /></td>
        <td className="r num"><Pair show={changed} before={inr(l.amount0)} after={inr(l.amount1)} /></td>
      </tr>,
    );
  }

  const moved = now.total !== base.total;
  return (
    <aside aria-label="Invoice">
      <header>
        <h3>Invoice</h3>
        {hasFormat ? (
          <div className="seg" role="group" aria-label="Show the invoice">
            <button type="button" aria-pressed={drafted} onClick={() => setMode("drafted")}>{labels[0]}</button>
            <button type="button" aria-pressed={!drafted} onClick={() => setMode("fixed")}>{labels[1]}</button>
          </div>
        ) : (
          <span>{caption ?? (grouped ? "grouped site-wise" : "as drafted")}</span>
        )}
      </header>
      {head && (
        <div className="inv-head">
          <span>PO <b className={lit("po") ? "hl" : undefined}>{head.po}</b></span>
          <span>SAC <b className={lit("sac") ? "hl" : undefined}>{head.sac}</b></span>
          <span>Dated <b className={lit("window") ? "hl" : undefined}>{head.date}</b></span>
          {head.window && <span className={`chip ${head.window.ok ? "ok" : "warn"}${lit("window") ? " hl" : ""}`}>{head.window.ok ? "✓" : "!"} {head.window.text}</span>}
        </div>
      )}
      {hasFormat && (
        <p className="fm-note">
          {drafted
            ? "How it started, before the agent's format fixes."
            : "Format fixes the agent made are in teal. No amount changed."}
        </p>
      )}
      <div className="scroll">
        <table>
          <thead>
            <tr><th>#</th><th>Line</th><th className="r">Qty</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      <dl className="tot">
        <dt>Wages</dt>
        <dd className="num"><Pair show={now.wages !== base.wages} before={inr(base.wages)} after={inr(now.wages)} /></dd>
        <dt>Statutory and service charge</dt>
        <dd className="num"><Pair show={now.statutory !== base.statutory} before={inr(base.statutory)} after={inr(now.statutory)} /></dd>
        <dt>GST 18%</dt>
        <dd className="num"><Pair show={now.gst !== base.gst} before={inr(base.gst)} after={inr(now.gst)} /></dd>
        <dt className="g">Total</dt>
        <dd className={`g num${moved ? " moved" : ""}`}><Pair show={moved} before={inr(base.total)} after={inr(now.total)} /></dd>
      </dl>
      {footer && <footer>{footer}</footer>}
    </aside>
  );
}
