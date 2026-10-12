import {
  findBuyer, getBuyer, latestInvoiceFor, loadAnnexure, loadDisputes, loadLocalEnv, loadPrompt, loadRulePool,
  loadSplit, writeRunArtifact,
} from "../src/lib/data/load";
import { assembleContext, type ContextInput } from "../src/lib/engine/context";
import { AnalysisError, runAnalysis } from "../src/lib/engine/llm_call";
import { geminiFromEnv } from "../src/lib/llm/gemini";
import { LlmError, type LlmProvider } from "../src/lib/llm/provider";
import type { Analysis } from "../src/lib/engine/analysis_schema";
import { judgeExisting, judgeNewRule } from "./judge";

/**
 * HARNESS, NOT RUNTIME. Does the classifier hold up? 18 live calls:
 *
 *   EXISTING  The rule is in the ledger, and the dispute is the one that taught it.
 *             Does the agent say "this was already a rule"?                    9 calls
 *   NEW       One rule per buyer is held out, and the dispute that taught it is
 *             fed in. Does the agent notice it is new and propose it?          9 calls
 *
 * Only a break fails the run. Wording, extra claims, confidence and the like are
 * printed for reading and never change the exit code. Exit 0 = nothing broke,
 * 1 = something broke, 2 = the API gave no answer for some case (not a break).
 *
 *   npm run eval                       everything
 *   npm run eval -- --only yogita      one buyer
 *   npm run eval -- --runs 1           one run per new-rule case instead of three
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};

/** One rule per buyer, held out. With 15 rules in the pool that leaves exactly the 12 that go into context. */
const HOLD = ["MER-R6", "YOG-R2", "TEA-R2"];

interface Case {
  kind: "existing" | "new";
  buyer: string;
  dispute: string;
  /** The rule this dispute teaches that the agent should match (existing) or learn (new). */
  rule: string;
  runs: number;
  /** Rules to hold out for this case, when it needs a different split from HOLD. */
  hold?: string[];
  /** Why this case cannot pass with today's data. A failure is reported but never counts as a break. */
  knownLimit?: string;
}

const NEW_RUNS = Math.max(1, Number(flag("runs") ?? 3));
const CASES: Case[] = [
  // Meridian
  { kind: "existing", buyer: "BUY-MERIDIAN", dispute: "DSP-004", rule: "MER-R3", runs: 1 }, // overtime needs an authorisation number
  { kind: "existing", buyer: "BUY-MERIDIAN", dispute: "DSP-008", rule: "MER-R4", runs: 1 }, // exited workers
  { kind: "existing", buyer: "BUY-MERIDIAN", dispute: "DSP-007", rule: "MER-R5", runs: 1 }, // group lines site-wise
  { kind: "new", buyer: "BUY-MERIDIAN", dispute: "DSP-006", rule: "MER-R6", runs: NEW_RUNS }, // the 1st-5th window
  // Yogita
  { kind: "existing", buyer: "BUY-YOGITA", dispute: "DSP-010", rule: "YOG-R3", runs: 1 }, // overtime approval
  { kind: "existing", buyer: "BUY-YOGITA", dispute: "DSP-011", rule: "YOG-R4", runs: 1 }, // service charge base
  { // absence over 3 days
    kind: "existing", buyer: "BUY-YOGITA", dispute: "DSP-012", rule: "YOG-R6", runs: 1,
    knownLimit: "the email names four workers and asks to deduct 22 man-days, but the dataset has no invoice or annexure for DSP-012, only Yogita's latest invoice, which lists no workers",
  },
  { kind: "new", buyer: "BUY-YOGITA", dispute: "DSP-009", rule: "YOG-R2", runs: NEW_RUNS }, // the 26th-25th cycle
  // Teamlease never writes. Its disputes are bank-statement notes, and only DSP-017 says anything the
  // agent can act on ("payment lands on day 45-47"). DSP-015 and DSP-018 carry no objection, so the agent
  // rightly returns nothing: they need the short-payment trigger, which v1 does not have. So the one
  // workable dispute is run both ways: in context three times (a different rule is held out for these),
  // and held out three times.
  { kind: "existing", buyer: "BUY-TEAMLEASE", dispute: "DSP-017", rule: "TEA-R2", runs: 1, hold: ["MER-R6", "YOG-R2", "TEA-R1"] },
  { kind: "existing", buyer: "BUY-TEAMLEASE", dispute: "DSP-017", rule: "TEA-R2", runs: 1, hold: ["MER-R6", "YOG-R2", "TEA-R1"] },
  { kind: "existing", buyer: "BUY-TEAMLEASE", dispute: "DSP-017", rule: "TEA-R2", runs: 1, hold: ["MER-R6", "YOG-R2", "TEA-R1"] },
  { kind: "new", buyer: "BUY-TEAMLEASE", dispute: "DSP-017", rule: "TEA-R2", runs: NEW_RUNS }, // 45-day payment terms
];

type Status = "pass" | "fail" | "no_answer";
interface RunResult {
  status: Status;
  reason: string;
  repaired?: boolean;
  claims?: string[];
  proposed?: string[];
  raw?: unknown;
}

const bar = (ch = "-") => console.log(ch.repeat(78));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string, n = 100) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function main() {
  loadLocalEnv();
  const only = flag("only") ? findBuyer(flag("only")!).id : undefined;
  const pool = loadRulePool();
  const disputes = loadDisputes();
  for (const hold of [HOLD, ...CASES.flatMap((c) => (c.hold ? [c.hold] : []))]) {
    const heldOut = loadSplit(0, hold).heldOut.map((r) => r.rule_id).sort().join(",");
    if (heldOut !== [...hold].sort().join(","))
      throw new Error(`the split held out ${heldOut}, expected exactly ${hold.join(",")}; the pool must have 15 rules`);
  }

  const provider: LlmProvider = geminiFromEnv();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const cases = CASES.filter((c) => !only || c.buyer === only);
  const total = cases.reduce((n, c) => n + c.runs, 0);

  bar("=");
  console.log(`CLASSIFIER EVAL   ${cases.length} cases, ${total} live calls   held out for the new-rule cases: ${HOLD.join(", ")}`);
  bar("=");

  const results: { case: Case; runs: RunResult[] }[] = [];
  let call = 0;
  let silent = 0; // consecutive calls the API did not answer
  let throttled = false;

  for (const c of cases) {
    if (throttled) break;
    const dispute = disputes.find((d) => d.dispute_id === c.dispute);
    if (!dispute) throw new Error(`unknown dispute ${c.dispute}`);
    const expectedRule = pool.find((r) => r.rule_id === c.rule);
    if (!expectedRule?.learned_from.includes(c.dispute))
      throw new Error(`${c.rule} is not taught by ${c.dispute}; the case list is out of date`);
    const invoice = latestInvoiceFor(c.buyer);
    const split = loadSplit(0, c.hold ?? HOLD);
    const allowedMatches = new Set(
      pool.filter((r) => r.learned_from.includes(c.dispute) && split.context.some((x) => x.rule_id === r.rule_id)).map((r) => r.rule_id),
    );

    const input: ContextInput = {
      buyer: getBuyer(c.buyer), invoice, annexure: loadAnnexure(invoice.invoice_id), rules: split.context,
      disputes, message: dispute.raw_text, receivedOn: dispute.received_at,
      systemPrompt: loadPrompt("analyze.md"), excludeDisputeIds: [c.dispute],
    };
    const ctx = assembleContext(input);
    const runs: RunResult[] = [];

    for (let n = 1; n <= c.runs; n++) {
      if (silent >= 3) {
        throttled = true;
        break;
      }
      call++;
      const label = `[${String(call).padStart(2)}/${total}] ${c.kind.toUpperCase().padEnd(8)} ${c.rule}  from ${c.dispute}${c.runs > 1 ? `  run ${n}/${c.runs}` : ""}`;
      process.stdout.write(`${label} ... `);
      const result = await runOnce(provider, ctx, c, expectedRule.check!, allowedMatches);
      runs.push(result);
      silent = result.status === "no_answer" ? silent + 1 : 0;
      console.log(`${result.status === "pass" ? "ok" : result.status === "fail" ? "BREAK" : "no answer"}  ${short(result.reason, 80)}`);
    }
    if (runs.length) results.push({ case: c, runs });
  }
  if (throttled)
    console.log("\nStopping early: the API has not answered 3 calls in a row. It is rate-limited, which is not a classifier failure. Try again in a few minutes.");

  writeRunArtifact(runId, "classifier-eval.json", results);

  // ---- what to read
  console.log();
  bar("=");
  console.log("FOR YOU TO READ  (never changes the result)");
  bar("=");
  for (const { case: c, runs } of results) {
    const rule = pool.find((r) => r.rule_id === c.rule)!;
    console.log(`\n${c.kind.toUpperCase()}  ${c.rule} via ${c.dispute}   expected: ${short(rule.rule, 90)}`);
    const first = runs.find((r) => r.claims);
    if (first) {
      for (const line of first.claims!) console.log(`   claim   ${line}`);
      if (c.kind === "new") for (const line of first.proposed!) console.log(`   rule    ${line}`);
    }
    if (runs.some((r) => r.repaired)) console.log("   note    needed one repair attempt");
  }

  // ---- verdict
  const breaks: string[] = [];
  const limits: string[] = [];
  const flaky: string[] = [];
  const unanswered: string[] = [];
  console.log();
  bar("=");
  console.log("RESULT");
  bar("=");
  for (const { case: c, runs } of results) {
    const passed = runs.filter((r) => r.status === "pass").length;
    const failed = runs.filter((r) => r.status === "fail").length;
    const none = runs.filter((r) => r.status === "no_answer").length;
    const answered = runs.length - none;
    const tag = `${c.kind.padEnd(8)} ${c.rule.padEnd(7)} ${c.dispute}`;
    // A break is a failure in the majority of answered runs. A single odd run out of three is flaky, not broken.
    const broken = answered > 0 && failed * 2 > answered;
    const status = none === runs.length ? "NO ANSWER" : c.knownLimit ? (failed ? "known limit" : "ok (limit no longer bites)") : broken ? "BREAK" : failed ? "flaky" : "ok";
    console.log(`  ${tag}   ${passed}/${runs.length} passed   ${status}`);
    if (c.knownLimit && failed) limits.push(`${c.rule} (${c.dispute}): ${c.knownLimit}`);
    else if (broken) breaks.push(`${c.kind} ${c.rule} (${c.dispute}): ${runs.find((r) => r.status === "fail")!.reason}`);
    else if (failed) flaky.push(`${c.kind} ${c.rule} (${c.dispute}): ${runs.find((r) => r.status === "fail")!.reason}`);
    if (none) unanswered.push(`${c.rule} (${c.dispute}): ${none} of ${runs.length} runs got no answer from the API`);
  }

  console.log();
  if (limits.length) {
    console.log("Known data limits (reported, not counted as breaks):");
    for (const l of limits) console.log(`  - ${l}`);
  }
  if (flaky.length) {
    console.log("Flaky, worth a second look but not a break:");
    for (const f of flaky) console.log(`  ~ ${f}`);
  }
  if (unanswered.length) {
    console.log("The API gave no answer (try again in a minute; this is not a classifier failure):");
    for (const u of unanswered) console.log(`  ? ${u}`);
  }
  if (breaks.length) {
    console.log("\nBROKEN:");
    for (const b of breaks) console.log(`  x ${b}`);
    console.log("\nFAIL: something that should never break, broke.");
    process.exitCode = 1;
  } else if (unanswered.length) {
    console.log("\nINCONCLUSIVE: nothing broke, but some cases did not get an answer.");
    process.exitCode = 2;
  } else {
    console.log("PASS: nothing broke.");
  }
  console.log(`\nraw replies and verdicts saved under state/runs/${runId}/`);
}

async function runOnce(
  provider: LlmProvider,
  ctx: ReturnType<typeof assembleContext>,
  c: Case,
  expectedCheck: NonNullable<ReturnType<typeof loadRulePool>[number]["check"]>,
  allowedMatches: ReadonlySet<string>,
): Promise<RunResult> {
  let analysis: Analysis | undefined;
  let repaired = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await runAnalysis(ctx, provider);
      analysis = out.analysis;
      repaired = out.meta.repaired;
      break;
    } catch (err) {
      if (err instanceof AnalysisError)
        return { status: "fail", reason: `the reply never validated: ${err.problems[0] ?? err.message}`, raw: err.raw };
      if (err instanceof LlmError && attempt < 3) {
        await sleep(30_000); // a busy API is not a verdict
        continue;
      }
      return { status: "no_answer", reason: (err as Error).message };
    }
  }
  if (!analysis) return { status: "no_answer", reason: "no reply" };

  const claims = analysis.claims.map(
    (cl) => `${cl.claim_id} [${cl.bucket}] ${short(cl.claim, 70)}  ->  ${cl.matched_rule_id ?? "no rule"}`,
  );
  const proposed = analysis.new_rules.map((r) => `[${r.type}] ${short(r.rule, 80)}  ${JSON.stringify(r.check)}`);
  const verdict =
    c.kind === "existing"
      ? judgeExisting(analysis, c.rule)
      : judgeNewRule(analysis, { expectedCheck, allowedMatches });
  return { status: verdict.pass ? "pass" : "fail", reason: verdict.reason, repaired, claims, proposed, raw: analysis };
}

main().catch((err) => {
  console.error(`eval: ${(err as Error).message}`);
  process.exitCode = 1;
});
