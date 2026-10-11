import { describe, expect, it } from "vitest";
import { processAnalysis } from "../src/lib/engine/analyze";
import { AnalysisSchema, type Analysis } from "../src/lib/engine/analysis_schema";
import { assembleContext } from "../src/lib/engine/context";
import { demoInput, demoReply, stubMeta } from "./demo_reply";
import { DEMO_CALLS, DEMO_REVISED_TOTAL } from "./toolcalls_cases";
import { judgeToolCalls } from "./toolcalls_judge";

const judge = (reply: Analysis) => {
  const inp = demoInput();
  const result = processAnalysis(inp, assembleContext(inp), reply, stubMeta);
  return judgeToolCalls(reply, result, DEMO_CALLS, { expectedRevisedTotalInr: DEMO_REVISED_TOTAL });
};

/** A deep copy the test can break. */
const clone = (): Analysis => AnalysisSchema.parse(JSON.parse(JSON.stringify(demoReply)));

describe("judgeToolCalls on the demo", () => {
  it("passes the correct reply, with every call exact", () => {
    const v = judge(demoReply);
    expect(v.pass).toBe(true);
    expect(v.rows.map((r) => r.status)).toEqual(["exact", "exact", "exact", "exact", "exact", "exact"]);
    expect(v.extras).toEqual([]);
    expect(v.rejected).toEqual([]);
  });

  it("passes a wrong quantity the engine fixed, and says the engine did the work", () => {
    const reply = clone();
    (reply.claims[1]!.proposed_calls[0] as { value: number }).value = 518;
    const v = judge(reply);
    expect(v.pass).toBe(true);
    expect(v.rows[2]).toMatchObject({ status: "corrected" });
    expect(v.rows[2]!.note).toContain("518");
    expect(v.reason).toContain("1 fixed by the engine");
  });

  it("fails when the model picks the wrong line", () => {
    const reply = clone();
    (reply.claims[0]!.proposed_calls[0] as { line_id: string }).line_id = "L10";
    const v = judge(reply);
    expect(v.pass).toBe(false);
    expect(v.rows[0]!.status).toBe("missing");
    expect(v.extras).toContain("adjust_line(L10, qty, 0)");
  });

  it("fails when a call is left out", () => {
    const reply = clone();
    reply.claims = reply.claims.filter((c) => c.claim_id !== "C5");
    reply.new_rules = [];
    const v = judge(reply);
    expect(v.pass).toBe(false);
    expect(v.rows.find((r) => r.expected.tool === "regroup_lines")!.status).toBe("missing");
  });

  it("fails on an extra business call that moves the money, though every expected call is present", () => {
    const reply = clone();
    reply.claims[1]!.proposed_calls.push({ tool: "adjust_line", line_id: "L1", field: "qty", value: 1, reason: "an overreach" });
    const v = judge(reply);
    expect(v.rows.every((r) => r.status === "exact")).toBe(true);
    expect(v.extras).toEqual(["adjust_line(L1, qty, 1)"]);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("revised total");
  });

  it("does not fail on an extra call that changes nothing", () => {
    const reply = clone();
    reply.claims[2]!.proposed_calls.push({ tool: "set_field", field: "sac", value: "998519" });
    const v = judge(reply);
    expect(v.pass).toBe(true);
    expect(v.extras).toEqual([]);
  });

  it("counts apply_template for PO and SAC when the invoice shows them, and does not call it an extra", () => {
    const reply = clone();
    reply.claims[2]!.proposed_calls = [{ tool: "apply_template" }];
    reply.claims[3]!.proposed_calls = [{ tool: "apply_template" }];
    const v = judge(reply);
    expect(v.pass).toBe(true);
    expect(v.rows.map((r) => r.status)).toEqual(["exact", "exact", "exact", "templated", "templated", "exact"]);
    expect(v.extras).toEqual([]);
    expect(v.reason).toContain("2 via apply_template");
  });

  it("does not let apply_template stand in for a regroup the ledger has not learned", () => {
    const reply = clone();
    reply.claims[4]!.proposed_calls = [{ tool: "apply_template" }];
    const v = judge(reply);
    expect(v.pass).toBe(false);
    expect(v.rows[5]!.status).toBe("missing");
  });
});
