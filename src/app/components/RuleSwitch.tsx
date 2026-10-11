"use client";

import { useState, useTransition } from "react";
import { setRuleStatus } from "../actions";

export function RuleSwitch({ ruleId, active, label }: { ruleId: string; active: boolean; label: string }) {
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const on = optimistic ?? active;
  return (
    <button
      role="switch" aria-checked={on} aria-label={`${label}: ${ruleId}`} className="switch" disabled={pending}
      onClick={() => {
        setOptimistic(!on);
        start(async () => {
          await setRuleStatus(ruleId, on ? "disabled" : "active");
          setOptimistic(null);
        });
      }}
    >
      <span className="track" aria-hidden="true" />
      <span>{on ? "On" : "Off"}</span>
    </button>
  );
}
