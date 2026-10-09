import { summariseApplied } from "../cli/render";
import { getBuyer, getInvoice, loadAnnexure, loadInvoices, loadLedger } from "../lib/data/load";
import { buildPreSendReport, type ReportItem } from "../lib/engine/presend";
import { applyToolCall, createDraft } from "../lib/engine/tools";

export const dynamic = "force-dynamic";

const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function Item({ item, kind }: { item: ReportItem; kind: "business" | "format" }) {
  const { finding: f, rule: r } = item;
  const workers = Array.isArray(f.facts.workers) ? f.facts.workers : [];
  return (
    <li className="item">
      <div className="itemhead">
        <span className="rid">{r.rule_id}</span>
        <span className={`conf ${r.confidence}`}>{r.confidence} confidence</span>
      </div>
      <p className="msg">{f.message}</p>
      {f.line_ids.length > 0 && (
        <p className="chips">{f.line_ids.map((id) => <span key={id} className="chip">{id}</span>)}</p>
      )}
      {workers.length > 0 && <ul className="workers">{workers.map((w) => <li key={w}>{w}</li>)}</ul>}
      <p className="prov">
        <b>Why:</b> {r.rule}
        <br />
        <b>Learned from</b> {r.learned_from.join(", ")} · confirmed {r.times_corroborated}×
      </p>
      <div className="actions">
        {kind === "business" && <><button disabled>Review proposal</button><span className="hint">needs your approval, changes what the buyer is billed</span></>}
        {kind === "format" && <span className="hint">will be fixed automatically, no amount changes</span>}
      </div>
    </li>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ invoice?: string; fix?: string }> }) {
  const q = await searchParams;
  const invoices = loadInvoices().filter((i) => i.status !== "sent" || true);
  const invoiceId = q.invoice ?? "INV-2026-0863";
  const invoice = getInvoice(invoiceId);
  const buyer = getBuyer(invoice.buyer_id);
  const rules = loadLedger();
  const annexure = loadAnnexure(invoiceId);
  const fixed = q.fix === "1";

  const before = buildPreSendReport({ invoice, buyer, annexure }, rules);
  let report = before;
  let applied: string[] = [];
  let shown = invoice;
  if (fixed) {
    const { draft } = applyToolCall(createDraft({ invoice, buyer, annexure, rules }), { tool: "apply_template" }, { actor: "engine" });
    report = buildPreSendReport({ invoice: draft.invoice, buyer, annexure: draft.annexure }, rules);
    applied = summariseApplied(draft.log);
    shown = draft.invoice;
  }

  const flagged = new Set([...report.business, ...report.format].flatMap((i) => i.finding.line_ids));
  const open = report.business.length + report.format.length;

  return (
    <div className="page">
      <div className="pick">
        {invoices.map((i) => (
          <a key={i.invoice_id} href={`/?invoice=${i.invoice_id}`} className={i.invoice_id === invoiceId ? "on" : ""}>
            {i.invoice_id.replace("INV-2026-", "")} · {i.buyer_name.split(" ")[0]} · {i.status}
          </a>
        ))}
      </div>

      <section className="hero">
        <div>
          <h1>{invoice.invoice_id} <small>{invoice.buyer_name}</small></h1>
          <p className="sub">{invoice.period_label} · {invoice.status} · dated {invoice.invoice_date} · due {invoice.due_date}</p>
        </div>
        <div className="verdict">
          {report.can_send_as_is ? (
            <span className="ok">Ready to send</span>
          ) : (
            <span className="bad">{plural(open, "issue")} before this can go out</span>
          )}
          <button className="send" disabled>Send invoice</button>
          {!report.can_send_as_is && <span className="hint">Resolve the items below first.</span>}
        </div>
      </section>

      <section className="tally">
        <div className="t business"><b>{report.business.length}</b><span>business lines to review</span></div>
        <div className="t format"><b>{fixed ? applied.length : report.format.length}</b><span>{fixed ? "format fixes applied" : "format fixes ready"}</span></div>
      </section>

      {!report.can_send_as_is && (
        <p className="callout">
          {report.foreseen_by.length > 0 && (
            <>These came from rules learned in <b>{plural(report.foreseen_by.length, "earlier dispute")}</b> ({report.foreseen_by.join(", ")}). Each was foreseeable before sending.</>
          )}
        </p>
      )}

      <div className="cols">
        <div className="main">
          {fixed ? (
            <div className="applied">
              <div className="applied-head">
                <b>Applied automatically ({applied.length})</b>
                <a href={`/?invoice=${invoiceId}`}>Undo</a>
              </div>
              <ul>{applied.map((a) => <li key={a}>✓ {a}</li>)}</ul>
              <p className="hint">No amount was changed. Nothing is saved yet.</p>
            </div>
          ) : (
            before.format.length > 0 && (
              <a className="applybtn" href={`/?invoice=${invoiceId}&fix=1`}>Apply {plural(before.format.length, "format fix", "format fixes")} automatically</a>
            )
          )}

          {report.business.length > 0 && (
            <div className="sec business"><h2>Business <small>propose · you approve</small></h2>
              <ul>{report.business.map((i) => <Item key={i.rule.rule_id} item={i} kind="business" />)}</ul></div>
          )}
          {report.format.length > 0 && (
            <div className="sec format"><h2>{fixed ? "Format: left for a person" : "Format"} <small>{fixed ? "could not be applied automatically" : "auto-apply"}</small></h2>
              <ul>{report.format.map((i) => <Item key={i.rule.rule_id} item={i} kind="format" />)}</ul></div>
          )}
          {report.manual.length > 0 && (
            <div className="sec manual"><h2>Needs a human <small>the checker cannot decide</small></h2>
              <ul>{report.manual.map((m) => <li key={m.rule_id} className="item"><span className="rid">{m.rule_id}</span> {m.note}</li>)}</ul></div>
          )}
          <p className="passed"><b>Passed ({report.passed.length}):</b> {report.passed.map((p) => p.rule_id).join(", ") || "none"}</p>
        </div>

        <aside>
          <h3>Invoice</h3>
          <table>
            <thead><tr><th>#</th><th>Line</th><th>PO</th><th>SAC</th><th className="r">Qty</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {shown.lines.map((l) => (
                <tr key={l.line_id} className={flagged.has(l.line_id) ? "flag" : ""}>
                  <td>{l.line_id}</td>
                  <td>{l.description}</td>
                  <td>{l.po_number ? "✓" : "—"}</td>
                  <td>{l.sac ? "✓" : "—"}</td>
                  <td className="r">{l.qty}</td>
                  <td className="r">{inr(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="tot">
            <dt>Wages</dt><dd>{inr(shown.totals.wages)}</dd>
            <dt>PF + ESI</dt><dd>{inr(shown.totals.pf_employer + shown.totals.esi_employer)}</dd>
            <dt>Service charge</dt><dd>{inr(shown.totals.service_charge)}</dd>
            <dt>GST (18%)</dt><dd>{inr(shown.totals.cgst + shown.totals.sgst)}</dd>
            <dt className="g">Total</dt><dd className="g">{inr(shown.totals.grand_total)}</dd>
          </dl>
          <p className="hint">PO {shown.po_number} · SAC {shown.sac}{annexure ? " · annexure on file" : ""}</p>
        </aside>
      </div>
    </div>
  );
}
