"use client";

import { useState, useTransition } from "react";
import { sendInvoice } from "../actions";

export function SendButton({ invoiceId, ready }: { invoiceId: string; ready: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <span role="alert" className="meta">{error}</span>}
      <button
        className={`btn ${ready ? "go" : "pri"}`} disabled={!ready || pending}
        onClick={() => start(async () => {
          const r = await sendInvoice(invoiceId);
          setError(r.ok ? null : (r.error ?? "Could not send."));
        })}
      >
        {pending ? "Sending…" : "Send invoice"}
      </button>
    </>
  );
}
