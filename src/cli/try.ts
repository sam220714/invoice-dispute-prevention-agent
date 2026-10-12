import {
  findBuyer, getBuyer, getInvoice, latestInvoiceFor, loadAnnexure, loadDemoDispute, loadDisputes, loadLocalEnv,
  loadPrompt, loadSplit, readMessageFile, writeRunArtifact,
} from "../lib/data/load";
import { DEMO_SEED } from "../lib/data/split";
import { processAnalysis } from "../lib/engine/analyze";
import { assembleContext, type ContextInput } from "../lib/engine/context";
import { analysisJsonSchema, parseAnalysis } from "../lib/engine/llm_call";
import { geminiFromEnv } from "../lib/llm/gemini";
import { LlmError } from "../lib/llm/provider";
import { renderAnalysis } from "./render";

/**
 * The prompt sandbox. One command to try the prompt and the model together:
 * split the rule pool by a seed, put 12 rules in the context, add a dispute, make
 * one live call, and print what came back. Edit prompts/analyze.md, run it again.
 *
 *   npm run try                                 the demo dispute, on the demo seed
 *   npm run try -- --seed 7                     the same dispute, a different split
 *   npm run try -- --dispute DSP-012            a historical dispute, as if it just arrived
 *   npm run try -- --file path/to/email.txt --buyer yogita    your own message
 *   npm run try -- --text "Kindly ..." --invoice INV-2026-0849   the same, inline
 *
 *   --hold A,B        force these rules out of the context whatever the seed says
 *                     (npm run try -- --hold MER-R3 tests whether the model learns the
 *                     overtime rule from the demo email); the seed chooses the rest
 *   --invoice ID      the invoice the message is about. Optional: without it, the buyer's
 *                     latest invoice that has gone out is used (never a draft)
 *   --buyer NAME      which buyer a --file/--text message is from (meridian, yogita,
 *                     teamlease). Not needed if --invoice is given, or for --dispute
 *   --runs N          call the model N times, to see how stable the answer is
 *   --engine          also run the reply through the engine: verified quantities, money
 *   --show-prompt     print the exact system prompt and context that were sent
 *   --dry             build the context and stop. No API call.
 *
 * It makes one call per run and shows the raw reply and any validation problems. It does
 * not repair a bad reply, because a prompt that needs repairing should show that.
 * Held-out rules are printed after the reply, for you to read. They are never sent.
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const has = (name: string) => args.includes(`--${name}`);
const bar = (ch = "-") => console.log(ch.repeat(78));

async function main() {
  loadLocalEnv();
  const seed = flag("seed") === undefined ? DEMO_SEED : Number(flag("seed"));
  if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, got "${flag("seed")}"`);
  const hold = (flag("hold") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const split = loadSplit(seed, hold);

  // ---- which dispute
  const disputes = loadDisputes();
  const disputeId = flag("dispute");
  let message: string;
  let buyerId: string;
  let label: string;
  let receivedOn = flag("received");
  let exclude: string[] = [];

  if (disputeId) {
    const d = disputes.find((x) => x.dispute_id === disputeId);
    if (!d) throw new Error(`unknown dispute ${disputeId}; try one of ${disputes.map((x) => x.dispute_id).join(", ")}`);
    message = d.raw_text;
    buyerId = d.buyer_id;
    receivedOn ??= d.received_at;
    exclude = [d.dispute_id];
    label = `${d.dispute_id} (${d.buyer_id}, ${d.received_at})`;
  } else if (flag("file") !== undefined || flag("text") !== undefined) {
    message = flag("file") !== undefined ? readMessageFile(flag("file")!) : flag("text")!;
    if (flag("invoice")) buyerId = getInvoice(flag("invoice")!).buyer_id;
    else if (flag("buyer")) buyerId = findBuyer(flag("buyer")!).id;
    else throw new Error("say whose message this is: --buyer meridian|yogita|teamlease, or --invoice ID");
    receivedOn ??= "2026-10-06";
    label = flag("file") ? `file ${flag("file")}` : "inline text";
  } else {
    message = loadDemoDispute();
    buyerId = "BUY-MERIDIAN";
    receivedOn ??= "2026-10-06";
    label = "the demo dispute (dataset/demo_dispute.txt)";
  }

  const invoice = flag("invoice") ? getInvoice(flag("invoice")!) : latestInvoiceFor(buyerId);
  const invoiceId = invoice.invoice_id;
  if (invoice.buyer_id !== buyerId) throw new Error(`${invoiceId} belongs to ${invoice.buyer_id}, not ${buyerId}`);

  const input: ContextInput = {
    buyer: getBuyer(buyerId),
    invoice,
    annexure: loadAnnexure(invoiceId),
    rules: split.context,
    disputes,
    message,
    receivedOn: receivedOn!,
    systemPrompt: loadPrompt("analyze.md"),
    excludeDisputeIds: exclude,
  };
  const ctx = assembleContext(input);
  const mine = (r: { buyer_id: string }) => r.buyer_id === buyerId;

  // ---- what is being tried
  bar("=");
  console.log(`PROMPT SANDBOX   seed ${seed}${seed === DEMO_SEED ? " (the demo seed)" : ""}${hold.length ? `   forced out: ${hold.join(", ")}` : ""}   ${label}`);
  bar("=");
  console.log(`invoice ${invoiceId}  (${invoice.period_label}, ${invoice.status})${flag("invoice") ? "" : "  <- the buyer's latest sent invoice; pass --invoice ID to choose another"}`);
  console.log(`held out of every buyer's context: ${split.heldOut.map((r) => r.rule_id).join(", ") || "nothing"}`);
  console.log(`context: ${split.context.length} rules in total, ${split.context.filter(mine).length} for this buyer:`);
  for (const r of split.context.filter(mine)) console.log(`   ${r.rule_id}  ${r.type.padEnd(8)} ${r.rule}`);
  console.log(`~${ctx.snapshot.est_tokens.toLocaleString()} tokens | prompts/analyze.md is ${ctx.system.length.toLocaleString()} characters`);
  if (has("show-prompt")) {
    console.log("\n--- SYSTEM ---\n" + ctx.system + "\n--- USER ---\n" + ctx.user + "\n--- END ---");
  }
  if (has("dry")) return;

  // ---- the calls
  const provider = geminiFromEnv();
  const runs = Math.max(1, Number(flag("runs") ?? 1));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  writeRunArtifact(runId, "prompt.txt", `--- SYSTEM ---\n${ctx.system}\n--- USER ---\n${ctx.user}\n`);

  for (let n = 1; n <= runs; n++) {
    console.log();
    bar("=");
    console.log(`RUN ${n} of ${runs}`);
    bar("=");
    const started = Date.now();
    const reply = await provider.generate({ system: ctx.system, user: ctx.user, schema: analysisJsonSchema() });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const u = reply.usage;
    console.log(`${reply.model} | ${secs}s${u ? ` | tokens in ${u.input} out ${u.output} thinking ${u.thinking}` : ""}`);
    const saved = writeRunArtifact(runId, `reply-${n}.json`, reply.text);
    console.log(`raw reply saved: ${saved}\n`);

    const parsed = parseAnalysis(reply.text, ctx);
    if (!parsed.ok) {
      console.log("THE REPLY DID NOT VALIDATE (the app would give the model one repair attempt):");
      for (const p of parsed.problems) console.log(`  - ${p}`);
      continue;
    }
    const a = parsed.analysis;

    console.log(`CLAIMS (${a.claims.length})`);
    for (const c of a.claims) {
      const calls = c.needs_human ? "needs a human (no tool can act on it)" : c.proposed_calls.map((p) => ("line_id" in p ? `${p.tool}(${p.line_id}${"value" in p ? `, ${p.value}` : ""})` : p.tool)).join("; ");
      console.log(`  ${c.claim_id} [${c.bucket}] ${c.claim}`);
      console.log(`      matched: ${c.matched_rule_id ?? "none"}   confidence: ${c.confidence}   fix: ${calls}`);
      console.log(`      why: ${c.match_rationale}`);
    }
    console.log(`\nNEW RULES PROPOSED (${a.new_rules.length})`);
    for (const r of a.new_rules) {
      console.log(`  [${r.type}] ${r.rule}`);
      console.log(`      check: ${JSON.stringify(r.check)}   from: ${r.claim_ids.join(",") || "a remark outside the numbered claims"}`);
    }
    if (a.unclear.length) {
      console.log(`\nUNCLEAR / NEEDS A HUMAN (${a.unclear.length})`);
      for (const u2 of a.unclear) console.log(`  ? ${u2}`);
    }

    if (has("engine")) {
      console.log();
      bar();
      const result = processAnalysis(input, ctx, a, {
        model: reply.model, repaired: false, attempts: reply.attempts,
        usage: reply.usage ?? { input: 0, output: 0, thinking: 0 },
      });
      console.log(renderAnalysis(result, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }));
    }
  }

  // ---- for you to read, never sent to the model
  console.log();
  bar("=");
  console.log("HELD OUT BY THIS SEED  (not in the context; read these against the reply)");
  bar("=");
  const held = split.heldOut.filter(mine);
  if (!held.length) console.log("  none of this buyer's rules are held out");
  for (const r of held) {
    const taught = r.learned_from.length ? `  [taught by ${r.learned_from.join(", ")}]` : "";
    console.log(`  ${r.rule_id}  ${r.type.padEnd(8)} ${r.rule}${taught}`);
  }
  if (disputeId) {
    const expected = [...split.context, ...split.heldOut].filter((r) => r.learned_from.includes(disputeId));
    console.log(`\nRules ${disputeId} is the source of:`);
    for (const r of expected)
      console.log(`  ${r.rule_id}  ${split.heldOut.some((h) => h.rule_id === r.rule_id) ? "HELD OUT: should be proposed as new" : "in context: should be matched"}`);
    if (!expected.length) console.log("  none (it taught no rule)");
  }
}

main().catch((err) => {
  if (err instanceof LlmError) {
    console.error(`try: ${err.message}${err.transient ? "\n  (transient: try again in a minute)" : ""}`);
  } else console.error(`try: ${(err as Error).message}`);
  process.exitCode = 1;
});
