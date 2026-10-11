/**
 * THE LOOP. Dispute resolved -> rule written -> the NEXT invoice flagged by it.
 * Without this the system demonstrates dispute resolution, which already exists,
 * instead of prevention, which is the thesis. Runs on a hand-written model reply
 * and a throwaway state directory, so it is free and leaves the real ledger alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getBuyer, getInvoice, loadAllDisputes, loadAnnexure, loadLedger, loadOutcomes,
  loadResolvedDisputes, recordOutcome, resetState, saveLedger,
} from "../src/lib/data/load";
import { DEMO_SEED } from "../src/lib/data/split";
import { processAnalysis } from "../src/lib/engine/analyze";
import { assembleContext, type ContextInput } from "../src/lib/engine/context";
import { applyApprovals } from "../src/lib/engine/learn";
import { buildPreSendReport } from "../src/lib/engine/presend";
import { demoInput, demoReply, stubMeta } from "./demo_reply";

let dir: string;
const previous = process.env.STATE_DIR;
const previousRules = process.env.LEDGER_RULES;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "loop-"));
  process.env.STATE_DIR = dir;
  // This loop is the seeded demo: three rules held out for the dispute to teach.
  process.env.LEDGER_RULES = "12";
  resetState(DEMO_SEED);
});
afterAll(() => {
  if (previousRules === undefined) delete process.env.LEDGER_RULES;
  else process.env.LEDGER_RULES = previousRules;
  if (previous === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const october = () => {
  const invoice = getInvoice("INV-2026-0863");
  return buildPreSendReport({ invoice, buyer: getBuyer(invoice.buyer_id), annexure: loadAnnexure(invoice.invoice_id) }, loadLedger());
};

/** The demo dispute, analysed against whatever the live ledger holds now. */
const analyse = () => {
  const input: ContextInput = { ...demoInput(), rules: loadLedger(), disputes: loadAllDisputes() };
  return processAnalysis(input, assembleContext(input), demoReply, stubMeta);
};

describe("dispute -> rule -> next invoice", () => {
  it("before: October's draft is not flagged for site-wise grouping", () => {
    expect(loadLedger().some((r) => r.rule_id === "MER-R2")).toBe(false);
    expect(october().format.map((i) => i.rule.rule_id)).not.toContain("MER-R2");
  });

  it("before: the ledger the demo starts from has 12 rules, and the three held out are unknown to it", () => {
    expect(loadLedger()).toHaveLength(12);
    expect(loadLedger().map((r) => r.rule_id)).not.toEqual(expect.arrayContaining(["MER-R2"]));
  });

  it("after the merchant approves, the rule is in the ledger and fires on the next invoice", () => {
    const result = analyse();
    const resolution = applyApprovals(result, { ledger: loadLedger(), disputes: loadAllDisputes() }, { approve_claims: ["C1", "C2"], approve_rules: "all" });

    expect(resolution.written.map((r) => r.rule_id)).toEqual(["MER-R2", "MER-R4"]);
    expect(resolution.written.map((r) => r.confidence)).toEqual(["medium", "medium"]); // one dispute, one observation
    expect(resolution.dispute.dispute_id).toBe("DSP-019");
    expect(resolution.merchant_accepted).toBe(true);

    saveLedger(resolution.ledger);
    recordOutcome(resolution.dispute, resolution.merchant_accepted);

    const report = october();
    const hit = report.format.find((i) => i.rule.rule_id === "MER-R2");
    expect(hit, "MER-R2 should flag INV-2026-0863").toBeDefined();
    expect(hit!.rule.learned_from).toEqual(["DSP-019"]);
    expect(report.foreseen_by).toContain("DSP-019");
  });

  it("the date window was learned too, and October's date honestly passes it", () => {
    const r4 = loadLedger().find((r) => r.rule_id === "MER-R4")!;
    expect(r4.check).toMatchObject({ kind: "invoice_date_window", from_day: 1, to_day: 5 });
    expect(october().passed.map((p) => p.rule_id)).toContain("MER-R4");
  });

  it("rules the dispute repeated were corroborated, not duplicated", () => {
    const ledger = loadLedger();
    for (const id of ["MER-R1", "MER-R3", "MER-R5", "MER-R6"])
      expect(ledger.find((r) => r.rule_id === id)!.learned_from).toContain("DSP-019");
    expect(ledger.filter((r) => r.buyer_id === "BUY-MERIDIAN")).toHaveLength(6); // 4 in context + MER-R2 + MER-R4, nothing twice
    expect(new Set(ledger.map((r) => r.rule_id)).size).toBe(ledger.length);
  });

  it("the outcome and the resolved dispute persist, and join the history", () => {
    expect(loadOutcomes()).toMatchObject([{ dispute_id: "DSP-019", merchant_accepted: true }]);
    expect(loadResolvedDisputes().map((d) => d.dispute_id)).toEqual(["DSP-019"]);
    expect(loadAllDisputes().at(-1)!.dispute_id).toBe("DSP-019");
  });

  it("declining a business claim leaves it out of the invoice and out of corroboration", () => {
    resetState(DEMO_SEED);
    const result = analyse();
    const r = applyApprovals(result, { ledger: loadLedger(), disputes: loadAllDisputes() }, { approve_claims: ["C2"], approve_rules: [] });
    expect(r.declined).toEqual(["C1"]);
    expect(r.merchant_accepted).toBe(false);
    expect(r.written).toEqual([]);
    expect(r.ledger.find((x) => x.rule_id === "MER-R5")!.learned_from).not.toContain("DSP-019");
    expect(r.invoice.lines.find((l) => l.line_id === "L9")!.qty).toBe(54);
    expect(r.invoice.lines.find((l) => l.line_id === "L6")!.qty).toBe(520);
  });
});
