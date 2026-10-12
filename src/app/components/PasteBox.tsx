"use client";

import { useActionState, useState } from "react";
import { analyzeAction, type AnalyzeState } from "../actions";

interface Props {
  invoiceId: string;
  buyer: string;
  rules: number;
  lines: number;
  /** An example message for this invoice, when the dataset has one. */
  sample: string | null;
  /** The invoice has not been sent yet. */
  draft?: boolean;
}

export function PasteBox({ invoiceId, buyer, rules, lines, sample, draft }: Props) {
  const [state, action, pending] = useActionState<AnalyzeState, FormData>(analyzeAction.bind(null, invoiceId), { response: null, text: "" });
  const [text, setText] = useState("");
  const r = state.response && !state.response.ok ? state.response : null;

  return (
    <div className="paste">
      <div className="verdict" style={{ borderBottom: 0, marginBottom: 6, paddingBottom: 6 }}>
        <div>
          <div className="flag" style={{ color: "var(--text-2)" }}>DISPUTE</div>
          <h2>Paste what {buyer} sent.</h2>
          <p className="sub">An email, a portal note or the text of a marked-up sheet. The agent reads it against {buyer}&apos;s {rules} rules and this invoice&apos;s {lines} lines.{draft && " This invoice has not been sent, so any rule it teaches is checked on this draft too."}</p>
        </div>
      </div>

      {r && !pending && (
        <div className="banner" role="alert">
          <p>{r.message}</p>
          {r.detail && r.detail.length > 0 && <ul>{r.detail.slice(0, 5).map((d, i) => <li key={i}>{d}</li>)}</ul>}
        </div>
      )}

      <form id="paste-form" action={action} className="card" aria-busy={pending}>
        <label className="sr" htmlFor="message">The buyer&apos;s message</label>
        <textarea
          id="message" name="message" className="field" value={text} required readOnly={pending}
          placeholder={`Paste the message from ${buyer} here`}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row2">
          <button className="btn pri" type="submit" disabled={pending || !text.trim()}>
            {pending ? "Reading the message…" : "Analyse message"}
          </button>
          {sample && !pending && (
            <button className="link" type="button" onClick={() => setText(sample)}>Use the example email</button>
          )}
          <span className="grow" />
        </div>
        {pending && (
          <div className="working" role="status">
            Checking each objection against {buyer}&apos;s rules and the annexure. This takes a few seconds.
            <div className="bar-progress" aria-hidden="true"><i /></div>
          </div>
        )}
      </form>
    </div>
  );
}
