import {
  findBuyer, getBuyer, getInvoice, latestInvoiceFor, loadAllDisputes, loadAnnexure, loadLedger, loadLocalEnv, loadPrompt, readMessageFile,
  recordOutcome, resetState, saveLedger, writeRunArtifact,
} from "../lib/data/load";
import { analyzeDispute, MessageNotReady } from "../lib/engine/analyze";
import { assembleContext, type ContextInput } from "../lib/engine/context";
import { applyApprovals } from "../lib/engine/learn";
import { AnalysisError } from "../lib/engine/llm_call";
import { buildPreSendReport } from "../lib/engine/presend";
import { geminiFromEnv } from "../lib/llm/gemini";
import { LlmError, type LlmProvider } from "../lib/llm/provider";
import { RecordingProvider, ReplayProvider } from "../lib/llm/replay";
import { renderAnalysis, renderReport, renderResolution } from "./render";

// npm run analyze -- [--dispute FILE] [--invoice ID | --buyer NAME] [--received YYYY-MM-DD]
//                    [--context] [--record NAME | --replay NAME] [--json]
//                    [--approve all|C1,C2] [--save] [--next INVOICE_ID] [--reset]
//   --context   print what the agent would look at, and stop. No API call.
//   --record    call the live model and save the reply as a fixture
//   --replay    answer from a saved fixture, offline
//   --approve   approve business claims (and every proposed rule), then show the revised invoice
//               anything not approved is left as it was, and the format fixes stay applied
//   --reason    with --approve: why the claims you did not approve were declined (goes on the dispute record)
//   --save      with --approve: write the ledger and the outcome to state/, closing the loop
//   --next      after saving, re-run the pre-send check on this invoice with the new ledger
//   --reset     start from the seeded ledger and an empty history
//   --seed N    split the rule pool with seed N (default: the demo seed, or LEDGER_SEED)
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const has = (name: string) => args.includes(`--${name}`);

async function main() {
  loadLocalEnv();
  if (flag("seed") !== undefined) process.env.LEDGER_SEED = flag("seed");
  if (has("reset")) resetState();
  const disputeFile = flag("dispute") ?? "dataset/demo_dispute.txt";
  // No invoice named: the buyer's latest sent invoice. No buyer named either: Meridian, the demo buyer.
  const invoiceId = flag("invoice") ?? latestInvoiceFor(flag("buyer") ? findBuyer(flag("buyer")!).id : "BUY-MERIDIAN").invoice_id;
  const receivedOn = flag("received") ?? "2026-10-06";
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const invoice = getInvoice(invoiceId);

  const input: ContextInput = {
    buyer: getBuyer(invoice.buyer_id),
    invoice,
    annexure: loadAnnexure(invoiceId),
    rules: loadLedger(),
    disputes: loadAllDisputes(),
    message: readMessageFile(disputeFile),
    receivedOn,
    systemPrompt: loadPrompt("analyze.md"),
  };

  const ctx = assembleContext(input);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const saved = writeRunArtifact(runId, "context.json", ctx.snapshot);

  console.log(`WHAT THE AGENT LOOKED AT  (${ctx.snapshot.built_for.buyer_id}, ${invoiceId})`);
  for (const s of ctx.snapshot.sections)
    console.log(`  ${s.name.padEnd(26)} ${String(s.items).padStart(3)}   ${s.detail}`);
  console.log(`  ~${ctx.snapshot.est_tokens.toLocaleString()} tokens | snapshot: ${saved}\n`);
  if (has("context")) return;

  let provider: LlmProvider;
  if (flag("replay")) provider = new ReplayProvider(flag("replay")!);
  else {
    const live = geminiFromEnv();
    provider = flag("record") ? new RecordingProvider(live, flag("record")!) : live;
  }

  const started = Date.now();
  const result = await analyzeDispute(input, provider);
  const { meta } = result;
  writeRunArtifact(runId, "analysis.json", result);
  const timing = `${((Date.now() - started) / 1000).toFixed(1)}s | tokens in ${meta.usage.input} out ${meta.usage.output} thinking ${meta.usage.thinking}`;

  if (has("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderAnalysis(result, { color }));
    console.log(`\n${timing}`);
  }

  const approve = flag("approve");
  if (approve === undefined) return;

  const claims = approve === "all" ? result.staged.map((s) => s.claim_id) : approve.split(",").map((s) => s.trim()).filter(Boolean);
  const resolution = applyApprovals(result, { ledger: input.rules, disputes: input.disputes }, {
    approve_claims: claims, approve_rules: "all",
    decline_reasons: flag("reason") ? Object.fromEntries(result.staged.filter((x) => !claims.includes(x.claim_id)).map((x) => [x.claim_id, flag("reason")!])) : undefined,
  });
  console.log(`\n${renderResolution(resolution, { color })}`);

  if (!has("save")) {
    console.log("\n(not saved: add --save to write the ledger and close the loop)");
    return;
  }
  saveLedger(resolution.ledger);
  recordOutcome(resolution.dispute, resolution.merchant_accepted);
  console.log(`\nSaved: ledger now has ${resolution.ledger.length} rules; ${resolution.dispute.dispute_id} filed.`);

  const next = flag("next");
  if (next) {
    const nextInvoice = getInvoice(next);
    const report = buildPreSendReport(
      { invoice: nextInvoice, buyer: getBuyer(nextInvoice.buyer_id), annexure: loadAnnexure(next) },
      resolution.ledger,
    );
    console.log("\nNOW THE NEXT INVOICE, WITH THE LEDGER THAT JUST LEARNED:\n");
    console.log(renderReport(report, { color }));
  }
}

main().catch((err) => {
  if (err instanceof MessageNotReady) {
    console.error(`analyze: ${err.message} Nothing was sent to the model.`);
  } else if (err instanceof AnalysisError) {
    console.error(`analyze: ${err.message}`);
    for (const p of err.problems) console.error(`  - ${p}`);
  } else if (err instanceof LlmError) {
    console.error(`analyze: ${err.message}${err.transient ? "\n  (transient: try again, or run with --replay)" : ""}`);
  } else console.error(`analyze: ${(err as Error).message}`);
  process.exitCode = 1;
});
