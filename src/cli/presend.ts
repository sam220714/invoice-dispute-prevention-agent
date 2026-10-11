import { getBuyer, getInvoice, loadAnnexure, loadLedger, loadOverrides, saveOverrides } from "../lib/data/load";
import { applyOverrides, recordOverride, revokeOverride, staleSignal } from "../lib/engine/overrides";
import { buildPreSendReport } from "../lib/engine/presend";
import { applyToolCall, createDraft } from "../lib/engine/tools";
import { renderReport, summariseApplied } from "./render";

// npm run presend -- [INVOICE_ID] [--fix] [--json]
//                    [--override RULE_ID [--reason TEXT] [--by NAME]] [--revoke RULE_ID]
//   --override  the merchant has looked at this business or manual-review finding and it is fine for THIS invoice.
//               Saved to state/overrides.json. Format fixes cannot be overridden. The rule itself is untouched.
//   --revoke    take an override back
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const has = (name: string) => args.includes(`--${name}`);
const FLAGS_WITH_VALUE = new Set(["override", "revoke", "reason", "by"]);
const positional = args.find((a, i) => !a.startsWith("--") && !(i > 0 && FLAGS_WITH_VALUE.has(args[i - 1]!.slice(2))));

const json = has("json");
const fix = has("fix");
const invoiceId = positional ?? "INV-2026-0863";

try {
  const invoice = getInvoice(invoiceId);
  const buyer = getBuyer(invoice.buyer_id);
  const rules = loadLedger();
  const annexure = loadAnnexure(invoice.invoice_id);

  let report = buildPreSendReport({ invoice, buyer, annexure }, rules);
  let applied: string[] | undefined;
  let log: unknown[] = [];

  if (fix) {
    // Format fixes only, and only in memory: the merchant has approved nothing yet.
    const { draft } = applyToolCall(createDraft({ invoice, buyer, annexure, rules }), { tool: "apply_template" }, { actor: "engine" });
    report = buildPreSendReport({ invoice: draft.invoice, buyer, annexure: draft.annexure }, rules);
    applied = summariseApplied(draft.log);
    log = draft.log;
  }

  let overrides = loadOverrides();
  const notes: string[] = [];

  const toOverride = flag("override");
  if (toOverride !== undefined) {
    const done = recordOverride(overrides, report, { rule_id: toOverride, reason: flag("reason"), by: flag("by") });
    overrides = done.overrides;
    saveOverrides(overrides);
    const sig = staleSignal(overrides, toOverride)!;
    notes.push(`Overrode ${toOverride} on ${invoiceId}${done.override.reason ? `: ${done.override.reason}` : " (no reason given)"}.`);
    if (sig.may_be_out_of_date)
      notes.push(`${toOverride} has now been overridden on ${sig.overridden_on.join(", ")}. It may be out of date: consider reviewing the rule.`);
  }

  const toRevoke = flag("revoke");
  if (toRevoke !== undefined) {
    const done = revokeOverride(overrides, invoiceId, toRevoke);
    overrides = done.overrides;
    if (done.removed) saveOverrides(overrides);
    notes.push(done.removed ? `Revoked the override of ${toRevoke} on ${invoiceId}.` : `${toRevoke} had no override on ${invoiceId}.`);
  }

  const reviewed = applyOverrides(report, overrides);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (json) console.log(JSON.stringify({ report: reviewed, applied: applied ?? [], log, notes }, null, 2));
  else {
    for (const n of notes) console.log(n);
    if (notes.length) console.log();
    console.log(renderReport(reviewed, { color, applied }));
  }
} catch (err) {
  console.error(`presend: ${(err as Error).message}`);
  process.exitCode = 1;
}
