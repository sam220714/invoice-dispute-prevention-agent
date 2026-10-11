/**
 * HARNESS, NOT RUNTIME. The manual override end to end, on a hand-written model reply and a throwaway
 * state directory: the merchant says no to the business proposals, and the invoice keeps its format fixes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getBuyer, getInvoice, loadAnnexure, loadLedger, loadOverrides, resetState, saveOverrides,
} from "../src/lib/data/load";
import { DEMO_SEED } from "../src/lib/data/split";
import { processAnalysis } from "../src/lib/engine/analyze";
import { assembleContext } from "../src/lib/engine/context";
import { applyApprovals } from "../src/lib/engine/learn";
import { applyOverrides, recordOverride } from "../src/lib/engine/overrides";
import { buildPreSendReport } from "../src/lib/engine/presend";
import { demoInput, demoReply, stubMeta } from "./demo_reply";

let dir: string;
const previous = process.env.STATE_DIR;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "override-"));
  process.env.STATE_DIR = dir;
  resetState(DEMO_SEED);
});
afterAll(() => {
  if (previous === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("overrides are kept between runs", () => {
  it("are saved, read back, and cleared by a demo reset", () => {
    const invoice = getInvoice("INV-2026-0863");
    const report = buildPreSendReport({ invoice, buyer: getBuyer(invoice.buyer_id), annexure: loadAnnexure(invoice.invoice_id) }, loadLedger());
    expect(loadOverrides()).toEqual([]);

    saveOverrides(recordOverride([], report, { rule_id: "MER-R5", reason: "verbal approval" }).overrides);
    const back = loadOverrides();
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ rule_id: "MER-R5", reason: "verbal approval", invoice_id: "INV-2026-0863" });
    expect(applyOverrides(report, back).overridden).toHaveLength(1);

    resetState(DEMO_SEED);
    expect(loadOverrides()).toEqual([]);
  });
});

describe("saying no to the business proposals in a dispute", () => {
  const run = () => {
    const input = { ...demoInput(), rules: loadLedger() };
    return { input, result: processAnalysis(input, assembleContext(input), demoReply, stubMeta) };
  };
  const state = (input: ReturnType<typeof demoInput>) => ({ ledger: input.rules, disputes: input.disputes });

  it("keeps the format fixes and changes no amount when nothing is approved", () => {
    const { input, result } = run();
    const r = applyApprovals(result, state(input), { approve_claims: [], approve_rules: [] });
    expect(r.declined).toEqual(["C1", "C2"]);
    expect(r.invoice.totals.grand_total).toBe(result.money.original_total_inr);
    expect(r.invoice.lines.every((l) => l.po_number === "MLP/PO/2026/3318" && l.sac === "998519")).toBe(true);
    expect(r.invoice.lines.map((l) => l.site_code)).toEqual(["SH", "SH", "SH", "SH", "MD", "MD", "MD", "MD", "PY", "PY", "PY"]);
    expect(r.merchant_accepted).toBe(false);
  });

  it("does not count a declined claim as proof that its rule was right", () => {
    const { input, result } = run();
    const r = applyApprovals(result, state(input), { approve_claims: [], approve_rules: [] });
    expect(r.corroborated.map((c) => c.rule_id)).toEqual(["MER-R1", "MER-R3"]); // the two format rules, not MER-R5 or MER-R6
  });

  it("writes the reason onto the dispute record when one is given", () => {
    const { input, result } = run();
    const r = applyApprovals(result, state(input), {
      approve_claims: ["C2"], approve_rules: [], decline_reasons: { C1: "site manager approved the OT by phone" },
    });
    expect(r.declined).toEqual(["C1"]);
    expect(r.dispute.resolution).toContain("Not approved: C1 (site manager approved the OT by phone).");
  });

  it("leaves the claim bare when no reason is given", () => {
    const { input, result } = run();
    const r = applyApprovals(result, state(input), { approve_claims: ["C2"], approve_rules: [] });
    expect(r.dispute.resolution).toContain("Not approved: C1.");
  });
});
