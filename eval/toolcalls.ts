import {
  getBuyer, latestInvoiceFor, loadAllDisputes, loadAnnexure, loadDemoDispute, loadDisputes, loadLocalEnv, loadPrompt,
  loadSplit, writeRunArtifact,
} from "../src/lib/data/load";
import { DEMO_SEED } from "../src/lib/data/split";
import { processAnalysis } from "../src/lib/engine/analyze";
import { assembleContext, type ContextInput } from "../src/lib/engine/context";
import { AnalysisError, runAnalysis } from "../src/lib/engine/llm_call";
import { geminiFromEnv } from "../src/lib/llm/gemini";
import { LlmError } from "../src/lib/llm/provider";
import { DEMO_CALLS, DEMO_REVISED_TOTAL, SINGLES } from "./toolcalls_cases";
import { judgeToolCalls, type ExpectedCall, type ToolCallVerdict } from "./toolcalls_judge";

/**
 * HARNESS, NOT RUNTIME. Does the model propose the right tool calls?
 *
 * The classifier eval asks whether the model recognises a rule. This one asks the
 * next question: given the claim, does it call the right tool on the right line
 * with the right value, and does the invoice that comes out carry the right money.
 *
 *   DEMO     the demo dispute against the demo ledger, 3 runs. The money must come
 *            out at the answer key's revised total to the paisa.        3 calls
 *   SINGLES  two old disputes, one tool call each.                      2 calls
 *
 * Only a wrong, missing or rejected call, or wrong money, is a failure. A quantity
 * the engine had to correct is passed but reported, so you know the safety net worked.
 * Exit 0 = nothing broke, 1 = something broke, 2 = the API gave no answer.
 *
 *   npm run eval:tools                  everything (5 live calls)
 *   npm run eval:tools -- --only demo   just the demo
 *   npm run eval:tools -- --runs 5      more demo runs
 *   npm run eval:tools -- --dry         print the plan and the expected calls, call nothing
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const has = (name: string) => args.includes(`--${name}`);

/** The same three held out as the classifier eval, for the single-dispute cases. */
const HOLD = ["MER-R4", "YOG-R2", "TEA-R2"];

interface Case {
  label: string;
  runs: number;
  expected: ExpectedCall[];
  input: () => ContextInput;
  expectedTotal?: number;
}

const only = flag("only");
const DEMO_RUNS = Math.max(1, Number(flag("runs") ?? 3));

const cases: Case[] = [];
if (!only || only === "demo")
  cases.push({
    label: "DEMO  INV-2026-0847 (Meridian, 6 Oct email)",
    runs: DEMO_RUNS,
    expected: DEMO_CALLS,
    expectedTotal: DEMO_REVISED_TOTAL,
    input: () => ({
      buyer: getBuyer("BUY-MERIDIAN"),
      invoice: latestInvoiceFor("BUY-MERIDIAN"),
      annexure: loadAnnexure(latestInvoiceFor("BUY-MERIDIAN").invoice_id),
      rules: loadSplit(DEMO_SEED).context,
      disputes: loadAllDisputes(),
      message: loadDemoDispute(),
      receivedOn: "2026-10-06",
      systemPrompt: loadPrompt("analyze.md"),
    }),
  });
if (!only || only === "singles")
  for (const s of SINGLES) {
    cases.push({
      label: `SINGLE ${s.dispute} (${s.buyer.replace("BUY-", "")})`,
      runs: 1,
      expected: s.expected,
      input: () => {
        const dispute = loadDisputes().find((d) => d.dispute_id === s.dispute);
        if (!dispute) throw new Error(`unknown dispute ${s.dispute}`);
        const invoice = latestInvoiceFor(s.buyer);
        return {
          buyer: getBuyer(s.buyer), invoice, annexure: loadAnnexure(invoice.invoice_id), rules: loadSplit(0, HOLD).context,
          disputes: loadDisputes(), message: dispute.raw_text, receivedOn: dispute.received_at,
          systemPrompt: loadPrompt("analyze.md"), excludeDisputeIds: [s.dispute],
        };
      },
    });
  }

const bar = (ch = "-") => console.log(ch.repeat(78));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const callText = (e: ExpectedCall) =>
  `${e.tool}(${[e.line_id, e.field, e.group_by, e.value === undefined ? undefined : JSON.stringify(e.value)].filter((x) => x !== undefined).join(", ")})`;

type Status = "pass" | "fail" | "no_answer";
interface RunResult {
  status: Status;
  reason: string;
  verdict?: ToolCallVerdict;
  raw?: unknown;
}

async function runOnce(provider: ReturnType<typeof geminiFromEnv>, c: Case): Promise<RunResult> {
  const input = c.input();
  const ctx = assembleContext(input);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { analysis, meta } = await runAnalysis(ctx, provider);
      const result = processAnalysis(input, ctx, analysis, meta);
      const verdict = judgeToolCalls(analysis, result, c.expected, { expectedRevisedTotalInr: c.expectedTotal });
      return { status: verdict.pass ? "pass" : "fail", reason: verdict.reason, verdict, raw: analysis };
    } catch (err) {
      if (err instanceof AnalysisError) return { status: "fail", reason: `the reply never validated: ${err.problems[0] ?? err.message}`, raw: err.raw };
      if (err instanceof LlmError && attempt < 3) {
        await sleep(30_000); // a busy API is not a verdict
        continue;
      }
      return { status: "no_answer", reason: (err as Error).message };
    }
  }
  return { status: "no_answer", reason: "no reply" };
}

async function main() {
  loadLocalEnv();
  const total = cases.reduce((n, c) => n + c.runs, 0);
  bar("=");
  console.log(`TOOL-CALL EVAL   ${cases.length} cases, ${total} live calls${has("dry") ? "   (dry run: nothing is called)" : ""}`);
  bar("=");

  if (has("dry")) {
    for (const c of cases) {
      console.log(`\n${c.label}   x${c.runs}${c.expectedTotal ? `   revised total must be Rs ${c.expectedTotal}` : ""}`);
      for (const e of c.expected) console.log(`   expect  [${e.bucket}] ${callText(e)}`);
    }
    return;
  }

  const provider = geminiFromEnv();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results: { label: string; runs: RunResult[] }[] = [];
  let call = 0;
  let silent = 0;

  outer: for (const c of cases) {
    const runs: RunResult[] = [];
    for (let n = 1; n <= c.runs; n++) {
      if (silent >= 3) break outer;
      call++;
      process.stdout.write(`[${call}/${total}] ${c.label}${c.runs > 1 ? `  run ${n}/${c.runs}` : ""} ... `);
      const r = await runOnce(provider, c);
      runs.push(r);
      silent = r.status === "no_answer" ? silent + 1 : 0;
      console.log(`${r.status === "pass" ? "ok" : r.status === "fail" ? "BREAK" : "no answer"}  ${r.reason.slice(0, 90)}`);
    }
    results.push({ label: c.label, runs });
  }
  if (silent >= 3) console.log("\nStopping early: the API has not answered 3 calls in a row. It is rate-limited, which is not a tool-call failure.");

  writeRunArtifact(runId, "toolcall-eval.json", results);

  console.log();
  bar("=");
  console.log("FOR YOU TO READ  (never changes the result)");
  bar("=");
  for (const { label, runs } of results) {
    console.log(`\n${label}`);
    runs.forEach((r, i) => {
      if (!r.verdict) return;
      const tag = runs.length > 1 ? `run ${i + 1}` : "";
      for (const row of r.verdict.rows) if (row.status !== "exact") console.log(`   ${tag.padEnd(6)} ${row.status.toUpperCase().padEnd(9)} ${row.note}`);
      if (r.verdict.extras.length) console.log(`   ${tag.padEnd(6)} extra     ${r.verdict.extras.join(", ")}`);
    });
  }

  const breaks: string[] = [];
  const unanswered: string[] = [];
  console.log();
  bar("=");
  console.log("RESULT");
  bar("=");
  for (const { label, runs } of results) {
    const passed = runs.filter((r) => r.status === "pass").length;
    const failed = runs.filter((r) => r.status === "fail").length;
    const none = runs.filter((r) => r.status === "no_answer").length;
    const fixed = runs.filter((r) => r.verdict?.rows.some((x) => x.status === "corrected")).length;
    const status = none === runs.length ? "NO ANSWER" : failed ? "BREAK" : "ok";
    console.log(`  ${label.padEnd(46)} ${passed}/${runs.length} passed${fixed ? `   engine corrected ${fixed}` : ""}   ${status}`);
    if (failed) breaks.push(`${label}: ${runs.find((r) => r.status === "fail")!.reason}`);
    if (none) unanswered.push(`${label}: ${none} of ${runs.length} runs got no answer`);
  }

  console.log();
  if (unanswered.length) {
    console.log("The API gave no answer (try again later; not a tool-call failure):");
    for (const u of unanswered) console.log(`  ? ${u}`);
  }
  if (breaks.length) {
    console.log("\nBROKEN:");
    for (const b of breaks) console.log(`  x ${b}`);
    console.log("\nFAIL: a tool call was wrong, missing or refused, or the money was off.");
    process.exitCode = 1;
  } else if (unanswered.length) {
    console.log("\nINCONCLUSIVE: nothing broke, but some cases did not get an answer.");
    process.exitCode = 2;
  } else {
    console.log("PASS: every tool call was right.");
  }
  console.log(`\nraw replies and verdicts saved under state/runs/${runId}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
