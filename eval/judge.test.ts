import { describe, expect, it } from "vitest";
import { AnalysisSchema, type Analysis } from "../src/lib/engine/analysis_schema";
import type { Check } from "../src/lib/schema";
import { canonical, judgeExisting, judgeNewRule, sameCheck } from "./judge";

const claim = (id: string, matched: string | null) => ({
  claim_id: id, claim: "x", quote: "q", bucket: "format", target: "all_lines", line_ids: [],
  matched_rule_id: matched, match_rationale: "r", proposed_calls: [{ tool: "apply_template" }], confidence: "high",
});
const rule = (check: Check) => ({
  type: "format", rule: "A standing requirement stated by the buyer.", quote: "q", claim_ids: [],
  check, confidence: "medium", rationale: "r",
});
const analysis = (claims: ReturnType<typeof claim>[], rules: ReturnType<typeof rule>[] = []): Analysis =>
  AnalysisSchema.parse({ claims, new_rules: rules, unclear: [] });

const WINDOW: Check = { kind: "invoice_date_window", from_day: 1, to_day: 5 };

describe("sameCheck", () => {
  it("ignores key order but not values", () => {
    expect(sameCheck(WINDOW, { to_day: 5, kind: "invoice_date_window", from_day: 1 } as Check)).toBe(true);
    expect(sameCheck(WINDOW, { kind: "invoice_date_window", from_day: 1, to_day: 6 })).toBe(false);
    expect(sameCheck(WINDOW, { kind: "payment_terms_days", days: 5 })).toBe(false);
  });
  it("is stable", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe("judgeExisting", () => {
  it("passes when some claim is matched to the expected rule", () => {
    expect(judgeExisting(analysis([claim("C1", null), claim("C2", "MER-R3")]), "MER-R3").pass).toBe(true);
  });
  it("fails on a wrong match, and says what was matched", () => {
    const v = judgeExisting(analysis([claim("C1", "MER-R4")]), "MER-R3");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("C1->MER-R4");
  });
  it("fails when nothing was matched, or there are no claims", () => {
    expect(judgeExisting(analysis([claim("C1", null)]), "MER-R3").pass).toBe(false);
    expect(judgeExisting(analysis([]), "MER-R3").pass).toBe(false);
  });
});

describe("judgeNewRule", () => {
  const opts = { expectedCheck: WINDOW, allowedMatches: new Set(["MER-R2"]) };

  it("passes when the expected check is proposed and nothing is wrongly matched", () => {
    const v = judgeNewRule(analysis([claim("C1", "MER-R2")], [rule(WINDOW)]), opts);
    expect(v).toMatchObject({ pass: true, wrongMatches: [] });
    expect(v.found).not.toBeNull();
  });

  it("matching a rule the same dispute also teaches is fine", () => {
    expect(judgeNewRule(analysis([claim("C1", "MER-R2")], [rule(WINDOW)]), opts).pass).toBe(true);
  });

  it("fails, and says so, when an unrelated existing rule is claimed to cover it", () => {
    const v = judgeNewRule(analysis([claim("C1", "MER-R1")], [rule(WINDOW)]), opts);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("unrelated existing rule");
    expect(v.wrongMatches).toEqual(["C1->MER-R1"]);
  });

  it("fails when no rule is proposed", () => {
    expect(judgeNewRule(analysis([claim("C1", null)]), opts).reason).toBe("proposed no rule at all");
  });

  it("fails when a rule is proposed but its check is different", () => {
    const v = judgeNewRule(analysis([claim("C1", null)], [rule({ kind: "invoice_date_window", from_day: 1, to_day: 7 })]), opts);
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("none with the expected check");
  });

  it("finds the expected rule among several proposals", () => {
    const v = judgeNewRule(analysis([], [rule({ kind: "payment_terms_days", days: 30 }), rule(WINDOW)]), opts);
    expect(v.pass).toBe(true);
  });
});
