import { getBuyer, getInvoice, loadAnnexure, loadLedger } from "../lib/data/load";
import { buildPreSendReport } from "../lib/engine/presend";
import { applyToolCall, createDraft } from "../lib/engine/tools";
import { renderReport, summariseApplied } from "./render";

// npm run presend -- [INVOICE_ID] [--fix] [--json]
const args = process.argv.slice(2);
const json = args.includes("--json");
const fix = args.includes("--fix");
const invoiceId = args.find((a) => !a.startsWith("--")) ?? "INV-2026-0863";

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

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log(json ? JSON.stringify({ report, applied: applied ?? [], log }, null, 2) : renderReport(report, { color, applied }));
} catch (err) {
  console.error(`presend: ${(err as Error).message}`);
  process.exitCode = 1;
}
