import { describe, expect, it } from "vitest";
import { toGeminiSchema } from "../llm/gemini";
import { StubProvider } from "../llm/replay";
import { getBuyer, getInvoice, loadAnnexure, loadDemoDispute, loadDisputes, loadSplit } from "../data/load";
import { DEMO_SEED } from "../data/split";
import { assembleContext } from "./context";
import { AnalysisError, analysisJsonSchema, parseAnalysis, runAnalysis } from "./llm_call";

const invoice = getInvoice("INV-2026-0847");
const ctx = assembleContext({
  buyer: getBuyer(invoice.buyer_id), invoice, annexure: loadAnnexure(invoice.invoice_id), rules: loadSplit(DEMO_SEED).context,
  disputes: loadDisputes(), message: loadDemoDispute(), receivedOn: "2026-10-06", systemPrompt: "SYSTEM",
});

const call = { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "no authorisation at Shamshabad" };
const good = (over: Record<string, unknown> = {}) => ({
  claims: [{
    claim_id: "C1", claim: "Overtime is not authorised", quote: "Kindly remove the unauthorised portion.",
    bucket: "business", target: "lines", line_ids: ["L9"], matched_rule_id: "MER-R5",
    match_rationale: "Unreferenced overtime is struck off.", proposed_calls: [call], confidence: "high", ...over,
  }],
  new_rules: [], unclear: [],
});
const text = (v: unknown) => JSON.stringify(v);

describe("parseAnalysis", () => {
  it("accepts a valid reply", () => {
    expect(parseAnalysis(text(good()), ctx).ok).toBe(true);
  });

  it("accepts a reply the model wrapped in a code fence", () => {
    expect(parseAnalysis("```json\n" + text(good()) + "\n```", ctx).ok).toBe(true);
  });

  it("rejects text that is not JSON", () => {
    const r = parseAnalysis("Here is my analysis: it looks fine.", ctx);
    expect(r).toMatchObject({ ok: false, problems: [expect.stringContaining("not valid JSON")] });
  });

  it("rejects the wrong shape and says where", () => {
    const r = parseAnalysis(text({ claims: [{ claim_id: "one" }], new_rules: [], unclear: [] }), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.some((p) => p.startsWith("claims.0."))).toBe(true);
  });

  it("rejects a quote that is not in the message", () => {
    const r = parseAnalysis(text(good({ quote: "The buyer disputes the overtime entirely." })), ctx);
    expect(r).toMatchObject({ ok: false, problems: [expect.stringContaining("not an exact span")] });
  });

  it("rejects a line id the invoice does not have, in the claim or in a call", () => {
    const inClaim = parseAnalysis(text(good({ line_ids: ["L99"] })), ctx);
    expect(!inClaim.ok && inClaim.problems.join()).toContain('line_id "L99" is not on this invoice');
    const inCall = parseAnalysis(text(good({ proposed_calls: [{ ...call, line_id: "L77" }] })), ctx);
    expect(!inCall.ok && inCall.problems.join()).toContain('names line "L77"');
  });

  it("rejects a matched rule that is not an active rule for this buyer", () => {
    for (const bad of ["MER-R99", "MER-R2", "YOG-R1"]) {
      const r = parseAnalysis(text(good({ matched_rule_id: bad })), ctx);
      expect(!r.ok && r.problems.join(), bad).toContain("not an active rule");
    }
  });

  it("rejects a matched rule id that contradicts the model's own rationale", () => {
    const slip = parseAnalysis(
      text(good({ matched_rule_id: "MER-R1", match_rationale: "Rule MER-R3 specifically covers SAC 998519." })),
      ctx,
    );
    expect(!slip.ok && slip.problems.join()).toContain("talks about MER-R3; make them agree");
  });

  it("lets a rationale name the matched rule, alone or beside others", () => {
    for (const why of ["MER-R5 covers this.", "Unlike MER-R1, MER-R5 is about overtime.", "Unreferenced overtime is struck off."]) {
      expect(parseAnalysis(text(good({ match_rationale: why })), ctx).ok, why).toBe(true);
    }
  });

  it("rejects a new rule whose pattern is not a valid regex", () => {
    const reply = good();
    (reply as Record<string, unknown>).new_rules = [{
      type: "format", rule: "Every line description must end with the site name.", quote: "site wise", claim_ids: [],
      check: { kind: "line_field_matches", field: "description", pattern: "^Shamshabad(" }, confidence: "medium", rationale: "x",
    }];
    const r = parseAnalysis(text(reply), ctx);
    expect(!r.ok && r.problems.join()).toContain("not a valid regular expression");
  });
});

describe("runAnalysis", () => {
  it("returns the analysis after a single call when the reply is valid", async () => {
    const stub = new StubProvider([text(good())]);
    const { analysis, meta } = await runAnalysis(ctx, stub);
    expect(analysis.claims).toHaveLength(1);
    expect(meta).toMatchObject({ repaired: false, model: "stub" });
    expect(stub.requests).toHaveLength(1);
  });

  it("sends the system prompt, the context and a response schema", async () => {
    const stub = new StubProvider([text(good())]);
    await runAnalysis(ctx, stub);
    const req = stub.requests[0]!;
    expect(req.system).toBe("SYSTEM");
    expect(req.user).toBe(ctx.user);
    expect(req.schema).toMatchObject({ type: "object", required: expect.arrayContaining(["claims", "new_rules"]) });
  });

  it("gives the model one repair attempt, showing it exactly what was wrong", async () => {
    const stub = new StubProvider(["not json at all", text(good())]);
    const { analysis, meta } = await runAnalysis(ctx, stub);
    expect(analysis.claims).toHaveLength(1);
    expect(meta.repaired).toBe(true);
    expect(stub.requests).toHaveLength(2);
    const repair = stub.requests[1]!.user;
    expect(repair).toContain(ctx.user);
    expect(repair).toContain("rejected by the validator");
    expect(repair).toContain("not valid JSON");
    expect(repair).toContain("not json at all");
  });

  it("repairs a fabricated quote the same way", async () => {
    const stub = new StubProvider([text(good({ quote: "made up" })), text(good())]);
    const { meta } = await runAnalysis(ctx, stub);
    expect(meta.repaired).toBe(true);
    expect(stub.requests[1]!.user).toContain("not an exact span");
  });

  it("gives up after one repair rather than looping", async () => {
    const stub = new StubProvider(["nope", "still nope"]);
    const err = await runAnalysis(ctx, stub).catch((e) => e);
    expect(err).toBeInstanceOf(AnalysisError);
    expect(err.problems.join()).toContain("not valid JSON");
    expect(err.raw).toBe("still nope");
    expect(stub.requests).toHaveLength(2);
  });
});

describe("the response schema", () => {
  const schema = analysisJsonSchema();
  const json = JSON.stringify(schema);

  it("is plain JSON Schema with no money field", () => {
    expect(schema.type).toBe("object");
    expect(json).not.toMatch(/"(amount|total|price|inr|rate|grand_total)[a-z_]*"\s*:/i);
  });

  it("is rewritten for Gemini: no const, no $schema", () => {
    const rewritten = JSON.stringify(toGeminiSchema(schema));
    expect(json).toContain('"const"');
    expect(rewritten).not.toContain('"const"');
    expect(rewritten).not.toContain("$schema");
    expect(rewritten).toContain('"enum":["adjust_line"]');
  });
});
