/**
 * HARNESS, NOT RUNTIME. Scores the tool calls a model proposed, kept apart from
 * the live calls so it can be tested without a model.
 *
 * Two layers are judged separately, because they fail for different reasons:
 *   raw    what the model proposed (a prompt problem)
 *   final  what the engine will actually run after it checks quantities against
 *          the annexure (what the merchant sees)
 * A call the model got wrong that the engine fixed is "corrected": safe, but
 * worth knowing, because it means the safety net did the work.
 */
import type { Analysis } from "../src/lib/engine/analysis_schema";
import type { AnalysisResult } from "../src/lib/engine/analyze";
import { toPaise } from "../src/lib/engine/arithmetic";
import type { Bucket } from "../src/lib/schema";

/** One call the right answer contains. Only the keys that matter are compared. */
export interface ExpectedCall {
  tool: string;
  bucket: Bucket;
  line_id?: string;
  field?: string;
  /** Compared exactly when present. Left out for set_field, where the engine only accepts the invoice's own value. */
  value?: number | string;
  group_by?: string;
  /**
   * apply_template runs every format rule in the ledger at once, and the prompt tells the model to use it when
   * an active rule covers the defect. So a template call also counts, if the invoice ends up in the right state.
   */
  viaTemplate?: (draft: AnalysisResult["draft"]) => boolean;
}

type Loose = { tool: string; line_id?: string; field?: string; value?: unknown; group_by?: string };

/** Which call is this, ignoring its value? Two calls with one identity are attempts at the same thing. */
const identity = (c: { tool: string; line_id?: string; field?: string; group_by?: string }) =>
  [c.tool, c.line_id ?? "", c.tool === "adjust_line" ? "" : (c.field ?? ""), c.group_by ?? ""].join("|");

const sameValue = (e: ExpectedCall, c: Loose) => e.value === undefined || e.value === c.value;

export type RowStatus = "exact" | "corrected" | "templated" | "wrong" | "missing";

export interface Row {
  expected: ExpectedCall;
  status: RowStatus;
  note: string;
}

export interface ToolCallVerdict {
  pass: boolean;
  reason: string;
  rows: Row[];
  /** Calls the model proposed that the right answer does not contain. Reported, never a failure on their own. */
  extras: string[];
  /** The engine refused something the model proposed. */
  rejected: string[];
}

export interface JudgeOptions {
  /** With every business proposal approved. Catches an extra or wrong call that the per-call rows missed. */
  expectedRevisedTotalInr?: number;
}

const show = (c: Loose) =>
  `${c.tool}(${[c.line_id, c.field, c.group_by, c.value === undefined ? undefined : JSON.stringify(c.value)].filter((x) => x !== undefined).join(", ")})`;

export function judgeToolCalls(
  analysis: Analysis,
  result: AnalysisResult,
  expected: ExpectedCall[],
  opts: JudgeOptions = {},
): ToolCallVerdict {
  const proposed = analysis.claims.flatMap((cl) => cl.proposed_calls.map((call) => ({ call: call as Loose, bucket: cl.bucket })));
  const final = result.outcomes.flatMap((o) => o.calls.map((call) => ({ call: call as Loose, bucket: o.claim.bucket })));

  const rows: Row[] = expected.map((e) => {
    const id = identity(e);
    const rawHit = proposed.find((p) => identity(p.call) === id);
    const finalHit = final.find((p) => identity(p.call) === id);

    if (!rawHit) {
      const template = proposed.find((p) => p.call.tool === "apply_template" && p.bucket === e.bucket);
      if (template && e.viaTemplate)
        return e.viaTemplate(result.draft)
          ? { expected: e, status: "templated", note: `${show(e)} done by apply_template, and the invoice shows it` }
          : { expected: e, status: "wrong", note: `apply_template was used for ${show(e)} but the invoice does not show it` };
      return { expected: e, status: "missing", note: `the model never proposed ${show(e)}` };
    }
    if (rawHit.bucket !== e.bucket)
      return { expected: e, status: "wrong", note: `${show(e)} sits in a ${rawHit.bucket} claim, expected ${e.bucket}` };
    const rawOk = sameValue(e, rawHit.call);
    if (!finalHit || !sameValue(e, finalHit.call))
      return { expected: e, status: "wrong", note: `proposed ${show(rawHit.call)}, ran ${finalHit ? show(finalHit.call) : "nothing"}, expected ${show(e)}` };
    if (rawOk) return { expected: e, status: "exact", note: show(e) };
    return { expected: e, status: "corrected", note: `the model proposed ${show(rawHit.call)}; the engine ran ${show(finalHit.call)}` };
  });

  const known = new Set(expected.map(identity));
  const templateUsed = rows.some((r) => r.status === "templated");
  const extras = proposed
    .filter((p) => !known.has(identity(p.call)) && !(templateUsed && p.call.tool === "apply_template"))
    .map((p) => show(p.call));
  const rejected = result.outcomes
    .filter((o) => o.status === "rejected")
    .map((o) => `${o.claim.claim_id}: ${o.steps.find((s) => s.status === "rejected")?.message ?? "rejected"}`);

  const problems: string[] = [];
  for (const r of rows) if (r.status === "wrong" || r.status === "missing") problems.push(r.note);
  for (const r of rejected) problems.push(`the engine rejected ${r}`);
  if (
    opts.expectedRevisedTotalInr !== undefined &&
    toPaise(result.money.revised_total_inr) !== toPaise(opts.expectedRevisedTotalInr)
  )
    problems.push(`revised total is Rs ${result.money.revised_total_inr}, expected Rs ${opts.expectedRevisedTotalInr}`);

  const corrected = rows.filter((r) => r.status === "corrected").length;
  const templated = rows.filter((r) => r.status === "templated").length;
  return {
    pass: problems.length === 0,
    reason: problems.length
      ? problems.join("; ")
      : `${rows.length} of ${rows.length} calls right${corrected ? ` (${corrected} fixed by the engine)` : ""}${templated ? ` (${templated} via apply_template)` : ""}`,
    rows,
    extras,
    rejected,
  };
}
