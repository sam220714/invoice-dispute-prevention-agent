"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { commitAnalysis, discardAnalysis, previewDecision } from "../actions";
import { plural, rupees, shortDate, Word, word } from "../../lib/app/format";
import type { AnalysisView, ClaimView, Preview, RuleView } from "../../lib/app/analysis_view";
import type { Chip } from "../../lib/app/chips";
import { activate, Call, Id, Sources, type Touch } from "./bits";
import { InvoiceBar } from "./InvoiceBar";
import { InvoicePanel } from "./InvoicePanel";

type Decision = "approved" | "declined";

const CHECK_WORDS: Record<string, string> = {
  verified: "Checked against the annexure",
  corrected: "Corrected from the annexure",
  unverified: "The annexure cannot settle this, so check it before approving",
  rejected: "Refused",
};

const SEEN: Record<NonNullable<ClaimView["seen"]>, string> = { foreseeable: "Foreseeable", new: "New Rule Learned" };

interface Bar { invoiceId: string; buyer: string; period: string; chip: Chip }

export function AnalysisBoard({ view, bar }: { view: AnalysisView; bar: Bar }) {
  const resolved = view.resolved;
  const proposed = view.claims.filter((c) => c.status === "proposed");
  const formatApplied = view.claims.filter((c) => c.bucket === "format" && c.status === "applied");

  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    if (!resolved) return {};
    const d: Record<string, Decision> = {};
    for (const id of resolved.approved) d[id] = "approved";
    for (const x of resolved.declined) d[x.claim_id] = "declined";
    return d;
  });
  const [reasons, setReasons] = useState<Record<string, string>>(() =>
    Object.fromEntries((resolved?.declined ?? []).flatMap((d) => (d.reason ? [[d.claim_id, d.reason]] : []))));
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [learn, setLearn] = useState<Set<number>>(() => new Set(view.rules.filter((r) => !r.duplicate_of).map((r) => r.ix)));
  const [selected, setSelected] = useState<string | null>(view.claims[0]?.claim_id ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [draftReason, setDraftReason] = useState("");
  const [tab, setTab] = useState<"message" | "invoice">("message");
  const [preview, setPreview] = useState<Preview>(view.preview);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  // The invoice under the current choices. Anything not declined counts: undecided claims are still on the table.
  const include = useMemo(() => proposed.filter((c) => decisions[c.claim_id] !== "declined").map((c) => c.claim_id), [proposed, decisions]);
  const sig = JSON.stringify([include, edits]);
  const first = useRef(true);
  useEffect(() => {
    if (resolved) return;
    if (first.current) { first.current = false; return; }
    let live = true;
    previewDecision(bar.invoiceId, include, edits).then((p) => { if (live && p) setPreview(p); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Light the words of the selected claim, and bring them into view.
  useEffect(() => {
    if (tab !== "message") return;
    const el = document.querySelector<HTMLElement>(".msg mark.lit");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [selected, tab]);

  const toggleOpen = (k: string) => setOpen((o) => (o === k ? null : k));
  const decide = (id: string, d: Decision | null) =>
    setDecisions((m) => { const n = { ...m }; if (d) n[id] = d; else delete n[id]; return n; });

  const pending = proposed.filter((c) => !decisions[c.claim_id]);
  const approvedN = proposed.filter((c) => decisions[c.claim_id] === "approved").length;
  const declinedN = proposed.filter((c) => decisions[c.claim_id] === "declined").length;
  const ruleBlocked = (r: RuleView) => r.claim_ids.length > 0 && r.claim_ids.every((id) => decisions[id] === "declined");

  const commit = (acceptPending: boolean) => {
    setError(null);
    const approved = proposed.filter((c) => decisions[c.claim_id] === "approved" || (acceptPending && !decisions[c.claim_id])).map((c) => c.claim_id);
    const keptEdits = Object.fromEntries(Object.entries(edits).filter(([k]) => approved.includes(k.split(":")[0]!)));
    startSave(async () => {
      const r = await commitAnalysis(bar.invoiceId, {
        approved,
        declined: proposed.filter((c) => decisions[c.claim_id] === "declined").map((c) => ({ claim_id: c.claim_id, reason: reasons[c.claim_id] ?? "" })),
        edits: keptEdits,
        learn: [...learn],
      });
      if (!r.ok) setError(r.error ?? "That could not be saved.");
    });
  };

  // ---- the one button in the bar
  let barLabel = "Save decisions";
  let acceptPending = false;
  if (proposed.length && pending.length === proposed.length) {
    barLabel = formatApplied.length ? `Accept ${proposed.length}, apply ${formatApplied.length}` : `Accept ${proposed.length}`;
    acceptPending = true;
  } else if (pending.length) {
    barLabel = `Accept the remaining ${pending.length}`;
    acceptPending = true;
  }

  // ---- what the selection touches on the invoice
  const sel = view.claims.find((c) => c.claim_id === selected);
  const selRule = selected?.startsWith("rule:") ? view.rules.find((r) => `rule:${r.ix}` === selected) : undefined;
  const touch: Touch = sel
    ? { ids: new Set(sel.line_ids), all: sel.all_lines, tone: sel.bucket === "business" ? "ochre" : "teal" }
    : selRule ? { ids: new Set(), all: false, tone: "teal" } : null;
  const fmtSelected = sel ? sel.bucket === "format" : Boolean(selRule);

  // ---- groups
  const isOpenCard = (c: ClaimView) =>
    c.status === "proposed" ? !decisions[c.claim_id] : c.status !== "applied";
  const needs = view.claims.filter(isOpenCard);
  const handled = view.claims.filter((c) => !isOpenCard(c));

  // ---- verdict
  const { matched, total } = view.foreseen;
  const say = resolved
    ? resolved.written.length
      ? `${Word(resolved.written.length)} new ${resolved.written.length === 1 ? "rule" : "rules"} will now be checked on every ${view.buyer_short} invoice.`
      : "Saved. The ledger already knew all of this."
    : total === 0
    ? "Nothing in this message asks for a change."
    : matched === 0
      ? "None of these objections were in your ledger yet."
      : matched === total
        ? total === 1 ? "The objection was already in your ledger." : `All ${word(total)} objections were already in your ledger.`
        : `${Word(matched)} of ${word(total)} objections were already in your ledger.`;
  let sub: string;
  if (resolved) sub = `Filed as ${resolved.dispute_id}. ${resolved.corroborated.length ? `${plural(resolved.corroborated.length, "rule")} already in the ledger ${resolved.corroborated.length === 1 ? "was" : "were"} confirmed again.` : ""}`;
  else if (total === 0) sub = "The agent found nothing in it to act on. If this was the wrong message, paste a different one.";
  else if (pending.length) sub = `${view.buyer_contact}'s message, read ${shortDate(view.received_on)}. ${pending.length === 1 ? "One changes" : `${Word(pending.length)} change`} the billed amount, so ${pending.length === 1 ? "it waits" : "they wait"} for you.`;
  else if (proposed.length) sub = "All decided. Save to write what this taught to the ledger.";
  else sub = `${view.buyer_contact}'s message, read ${shortDate(view.received_on)}. Nothing here changes the billed amount.`;

  const verdictFlag = resolved ? "SAVED" : total === 0 ? "NO CLAIMS" : matched ? "FORESEEABLE" : "NEW";
  const verdictTone = resolved ? "saved" : "attn";
  const rupeeNote = declinedN
    ? `revised total · you declined ${declinedN}`
    : `collectable today · ${rupees(preview.total_reduction)} off the invoice`;

  // ---- invoice panel lines with the preview applied
  const panelLines = view.lines.map((l) => {
    const p = preview.lines[l.line_id];
    return { line_id: l.line_id, description: l.description, site_name: l.site_name, site_full: l.site_full, unit: l.unit, qty0: l.qty, qty1: p?.qty ?? l.qty, amount0: l.amount, amount1: p?.amount ?? l.amount };
  });

  const card = (c: ClaimView) => (
    <ClaimCard
      key={c.claim_id} c={c} on={selected === c.claim_id} open={open === c.claim_id}
      amount={preview.per_claim[c.claim_id] ?? c.amount}
      edited={c.edits.some((e) => edits[e.key] !== undefined || resolved?.edited.includes(e.key))}
      editing={editing === c.claim_id} declining={declining === c.claim_id}
      draftReason={draftReason} edits={edits} busy={saving}
      decision={decisions[c.claim_id]} decisionReason={reasons[c.claim_id]} locked={Boolean(resolved)}
      onSelect={() => setSelected(c.claim_id)}
      onToggle={() => toggleOpen(c.claim_id)}
      onApprove={() => { decide(c.claim_id, "approved"); setEditing(null); setDeclining(null); }}
      onEdit={() => { setEditing(editing === c.claim_id ? null : c.claim_id); setDeclining(null); setSelected(c.claim_id); }}
      onEditQty={(key, v, max) => setEdits((m) => ({ ...m, [key]: Math.max(0, Math.min(max, Number.isFinite(v) ? v : max)) }))}
      onResetEdits={() => setEdits((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(`${c.claim_id}:`))))}
      onDeclineStart={() => { setDeclining(declining === c.claim_id ? null : c.claim_id); setEditing(null); setDraftReason(""); setSelected(c.claim_id); }}
      onReason={setDraftReason}
      onDecline={() => { decide(c.claim_id, "declined"); setReasons((m) => ({ ...m, [c.claim_id]: draftReason.trim() })); setDeclining(null); }}
      onCancel={() => { setDeclining(null); setEditing(null); }}
      onUndo={() => decide(c.claim_id, null)}
    />
  );

  return (
    <>
      <InvoiceBar invoiceId={bar.invoiceId} buyer={bar.buyer} period={bar.period} chip={bar.chip}>
        {!resolved && proposed.length > 0 && (
          <button className="btn pri" disabled={saving} onClick={() => commit(acceptPending)}>
            {saving ? "Saving…" : barLabel}
          </button>
        )}
        {!resolved && proposed.length === 0 && total > 0 && (
          <button className="btn pri" disabled={saving} onClick={() => commit(false)}>{saving ? "Saving…" : "Save what this taught"}</button>
        )}
      </InvoiceBar>

      <main>
        <div className={`verdict ${verdictTone}`}>
          <div>
            <div className="flag">{verdictFlag}</div>
            <h2>{say}</h2>
            <p className="sub">{sub}</p>
            {total === 0 && !resolved && (
              <button
                className="btn go-link" disabled={saving} style={{ marginTop: 14 }}
                onClick={() => startSave(async () => { await discardAnalysis(bar.invoiceId); })}
              >
                Paste a different message
              </button>
            )}
            {resolved?.next_draft && (
              <Link className="btn go go-link" href={`/invoices/${resolved.next_draft.invoice_id}`}>
                Run the pre-send check on {resolved.next_draft.period_label}&apos;s draft →
              </Link>
            )}
          </div>
          {proposed.length > 0 && (
            <div className="money">
              <b className="num">{rupees(preview.revised_total)}</b>
              <span>{resolved ? `revised total · ${rupees(resolved.total_reduction)} off the invoice` : rupeeNote}</span>
            </div>
          )}
        </div>

        {total > 0 && (
        <div className="cols">
          <div>
            {error && <div className="banner" role="alert"><p>{error}</p></div>}

            {needs.length > 0 && <p className="lbl">Needs you</p>}
            {needs.map(card)}

            {handled.length > 0 && <p className="lbl f">Already handled</p>}
            {handled.map(card)}

            {!resolved && view.rules.some((r) => !r.duplicate_of) && <p className="lbl f">New rules for {view.buyer_short}&apos;s ledger</p>}
            {!resolved && view.rules.filter((r) => !r.duplicate_of).map((r) => (
              <RuleRow
                key={r.ix} r={r} on={selected === `rule:${r.ix}`} checked={learn.has(r.ix) && !ruleBlocked(r)} blocked={ruleBlocked(r)}
                onSelect={() => setSelected(`rule:${r.ix}`)}
                onToggle={() => setLearn((s) => { const n = new Set(s); if (n.has(r.ix)) n.delete(r.ix); else n.add(r.ix); return n; })}
              />
            ))}

            {resolved && (
              <>
                {resolved.written.map((w) => (
                  <div className="done" key={w.rule_id}>
                    <div className="row" style={{ cursor: "default" }}>
                      <span className="tick" aria-hidden="true">✓</span>
                      <div className="what">
                        Written to the ledger: {w.text}
                        <i><Id>{w.rule_id}</Id> · from <Sources sources={w.sources.map((id) => ({ id, date: null }))} /> · checked on every {view.buyer_short} invoice from now on</i>
                      </div>
                    </div>
                  </div>
                ))}
                {resolved.corroborated.length > 0 && (
                  <div className="done">
                    <div className="row" style={{ cursor: "default" }}>
                      <span className="tick" aria-hidden="true">✓</span>
                      <div className="what">
                        {plural(resolved.corroborated.length, "existing rule")} confirmed again
                        <i>Each one that saw a second dispute is more trusted</i>
                      </div>
                      <button className="why" aria-expanded={open === "confirmed"} onClick={() => toggleOpen("confirmed")}>what</button>
                    </div>
                    <div className="more" hidden={open !== "confirmed"}>
                      <ul>
                        {resolved.corroborated.map((c) => (
                          <li key={c.rule_id}>
                            <Id>{c.rule_id}</Id> {c.text} · seen {plural(c.times_after, "time")}
                            {c.confidence_after !== c.confidence_before && `, now ${c.confidence_after} confidence`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </>
            )}

            {total > 0 && view.unclear.length > 0 && (
              <>
                <p className="lbl" style={{ marginTop: 24 }}>The agent could not place</p>
                {view.unclear.map((u, i) => (
                  <div className="find" key={i}>
                    <div className="row" style={{ cursor: "default" }}>
                      <div><div className="what" style={{ fontSize: 15, fontWeight: 500 }}>{u}</div><div className="where">Needs a person</div></div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <aside className="msg" aria-label="Source">
            <header style={{ padding: 0, display: "block" }}>
              <div className="tabs2" role="tablist">
                <button role="tab" aria-selected={tab === "message"} onClick={() => setTab("message")}>What {view.buyer_contact} wrote</button>
                <button role="tab" aria-selected={tab === "invoice"} onClick={() => setTab("invoice")}>Invoice</button>
              </div>
            </header>

            {tab === "message" ? (
              <>
                {total > 0 && <p className="sub2">The highlighted words belong to the claim you selected</p>}
                <div className="text">
                  {view.segments.map((s, i) =>
                    s.keys.length
                      ? <mark key={i} className={`${selected && s.keys.includes(selected) ? "lit" : ""}${selected && s.keys.includes(selected) && fmtSelected ? " f" : ""}`}>{s.text}</mark>
                      : <span key={i}>{s.text}</span>)}
                </div>
              </>
            ) : (
              <div style={{ marginTop: 0 }}>
                <InvoicePanelEmbedded view={view} lines={panelLines} preview={preview} touch={touch} />
              </div>
            )}

            {!resolved && (
              <footer>
                <button
                  className="btn" disabled={saving}
                  onClick={() => startSave(async () => { await discardAnalysis(bar.invoiceId); })}
                >
                  Paste a different message
                </button>
              </footer>
            )}
          </aside>
        </div>
        )}
      </main>
    </>
  );
}

// The invoice tab reuses the same panel, without its own card chrome nested in the source card.
function InvoicePanelEmbedded({ view, lines, preview, touch }: {
  view: AnalysisView; lines: React.ComponentProps<typeof InvoicePanel>["lines"]; preview: Preview; touch: Touch;
}) {
  return (
    <InvoicePanel
      lines={lines} grouped={view.grouped_by_site} base={view.base_totals} now={preview.totals} touch={touch}
    />
  );
}

// ------------------------------------------------------------------- cards
interface CardProps {
  c: ClaimView; on: boolean; open: boolean; amount: number | null; edited: boolean;
  editing: boolean; declining: boolean; draftReason: string; edits: Record<string, number>; busy: boolean;
  decision: Decision | undefined; decisionReason: string | undefined; locked: boolean;
  onSelect: () => void; onToggle: () => void;
  onApprove: () => void; onEdit: () => void; onEditQty: (key: string, v: number, max: number) => void; onResetEdits: () => void;
  onDeclineStart: () => void; onReason: (v: string) => void; onDecline: () => void; onCancel: () => void; onUndo: () => void;
}

function ClaimCard(p: CardProps) {
  const { c, on, open, decision } = p;
  const biz = c.bucket === "business";
  const why = (
    <div className="more" hidden={!open}>
      <Call calls={c.calls} />
      {c.checks.length > 0 && (
        <ul className="plain">
          {c.checks.map((k) => (
            <li key={k.line_id}><Id>{k.line_id}</Id> {CHECK_WORDS[k.verdict] ?? k.verdict}: {k.basis}</li>
          ))}
        </ul>
      )}
      <p className="rule">{c.rationale}</p>
      <p className="from">
        {c.foresight
          ? <>Matches <Id>{c.foresight.rule_id}</Id>, learned from <Sources sources={c.foresight.sources} /></>
          : "No rule in the ledger covered this."}
      </p>
    </div>
  );

  // A decided or applied claim is a flat row: the system, or the merchant, has settled it.
  if (decision || c.status === "applied") {
    const declined = decision === "declined";
    return (
      <div className={`done${on ? " on" : ""}${declined ? " set-aside" : ""}`}>
        <div className="row" onClick={p.onSelect}>
          <span className="tick" aria-hidden="true">{declined ? "–" : "✓"}</span>
          <div className="what" role="button" tabIndex={0} aria-pressed={on} onKeyDown={activate(p.onSelect)}>
            {c.title}
            <i>
              <span className={`tag ${biz ? "biz" : "fmt"}`} style={{ marginRight: 8 }}>{biz ? "Business" : "Format"}</span>
              {declined
                ? `Declined${p.decisionReason ? `: ${p.decisionReason}` : ""}`
                : <>{c.where}{p.edited && " · edited"}{c.seen && <> · <span className={`seen${c.seen === "new" ? " new" : ""}`}>{SEEN[c.seen]}</span></>}</>}
            </i>
          </div>
          {decision === "approved" && p.amount !== null && <span className="cut num">−{rupees(p.amount)}</span>}
          {c.status === "applied" && <span className="cut num" style={{ fontWeight: 500 }}>applied</span>}
          {decision && !p.locked && (
            <button className="link" onClick={(e) => { e.stopPropagation(); p.onUndo(); }}>Undo</button>
          )}
          <button className="why" aria-expanded={open} onClick={(e) => { e.stopPropagation(); p.onToggle(); }}>why</button>
        </div>
        {why}
      </div>
    );
  }

  return (
    <article className={`claim ${biz ? "biz" : "fmt"}${on ? " on" : ""}`}>
      <div className="row" role="button" tabIndex={0} aria-pressed={on} onClick={p.onSelect} onKeyDown={activate(p.onSelect)}>
        <span className={`tag ${biz ? "biz" : "fmt"}`}>{biz ? "Business" : "Format"}</span>
        <div>
          <div className="what">{c.title}</div>
          <div className="where">
            {c.where}
            {c.seen && <span className={`seen${c.seen === "new" ? " new" : ""}`}>{SEEN[c.seen]}</span>}
          </div>
        </div>
        {c.status === "proposed" && p.amount !== null
          ? <div className="amt num">−{rupees(p.amount)}<em>{p.edited ? "edited" : "off the invoice"}</em></div>
          : <div className="amt zero">{c.status === "needs_human" ? "needs a person" : c.status === "partial" ? "partly applied" : "not applied"}</div>}
      </div>
      {c.notes.map((n, i) => <p className="stale" key={i}>{n}</p>)}
      <div className="act">
        {c.status === "proposed" && !p.locked && (
          <>
            <button className="btn pri" disabled={p.busy} onClick={p.onApprove}>Approve</button>
            {c.edits.length > 0 && <button className="btn" aria-expanded={p.editing} onClick={p.onEdit}>Edit</button>}
            <button className="btn" aria-expanded={p.declining} onClick={p.onDeclineStart}>Decline</button>
          </>
        )}
        <button className="why" aria-expanded={open} onClick={p.onToggle}>why</button>
      </div>

      {p.editing && (
        <div className="edits">
          {c.edits.map((e) => {
            const value = p.edits[e.key] ?? e.proposed;
            return (
              <label key={e.key}>
                <span><Id>{e.line_id}</Id> {e.label}: bill</span>
                <input
                  className="field num" type="number" min={0} max={e.current} step="any" value={value}
                  onChange={(ev) => p.onEditQty(e.key, Number(ev.target.value), e.current)}
                />
                <span>of {e.current} {e.unit}</span>
                <span className="hint">agent proposed {e.proposed}</span>
              </label>
            );
          })}
          <div><button className="link" onClick={p.onResetEdits}>Back to the proposal</button></div>
        </div>
      )}

      {p.declining && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); p.onDecline(); }}>
          <label className="sr" htmlFor={`why-${c.claim_id}`}>Why is this claim wrong?</label>
          <input
            id={`why-${c.claim_id}`} className="field" autoFocus value={p.draftReason} maxLength={300}
            placeholder="Why is the buyer wrong? (optional)" onChange={(e) => p.onReason(e.target.value)}
          />
          <button className="btn pri" type="submit">Decline</button>
          <button className="btn" type="button" onClick={p.onCancel}>Cancel</button>
        </form>
      )}
      {why}
    </article>
  );
}

function RuleRow({ r, on, checked, blocked, onSelect, onToggle }: {
  r: RuleView; on: boolean; checked: boolean; blocked: boolean; onSelect: () => void; onToggle: () => void;
}) {
  return (
    <div className={`done${on ? " on" : ""}`}>
      <div className="row" onClick={onSelect}>
        <label className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={checked} disabled={blocked} onChange={onToggle} onFocus={onSelect} aria-label="Remember this rule" />
          <span className="what" style={{ fontWeight: 500, fontSize: 16 }}>
            {r.text}
            <i style={{ display: "block", fontStyle: "normal", color: "var(--text-3)", fontSize: 14, marginTop: 2 }}>
              {blocked ? "Not learned: you declined the claim behind it" : <><span className={`tag ${r.type === "business" ? "biz" : "fmt"}`} style={{ marginRight: 8 }}>{r.type === "business" ? "Business" : "Format"}</span>checked on every invoice from now on</>}
            </i>
          </span>
        </label>
      </div>
    </div>
  );
}
