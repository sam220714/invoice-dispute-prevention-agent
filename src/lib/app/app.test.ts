import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetState } from "../data/load";
import { DEMO_SEED } from "../data/split";
import { compactLines, inr, rupees, shortDate, Word } from "./format";
import { buildPresendView, workingDraft } from "./presend_view";
import { proposeFor } from "./propose";
import { locate, segmentMessage } from "./quotes";
import { receivedOn } from "./run_analysis";
import { loadRecord, resetApp, saveRecord } from "./store";
import { buildPreSendReport } from "../engine/presend";
import { applyToolCall } from "../engine/tools";

describe("format", () => {
  it("groups digits the Indian way and keeps two decimals", () => {
    expect(inr(2488552.84)).toBe("24,88,552.84");
    expect(rupees(48444.4)).toBe("₹48,444.40");
  });
  it("words, dates and line ranges", () => {
    expect(Word(4)).toBe("Four");
    expect(shortDate("2026-10-06")).toBe("6 Oct");
    expect(compactLines(["L9", "L11", "L10", "L1"])).toBe("L1, L9-L11");
  });
});

describe("quotes", () => {
  const msg = "Dear Madam,\n\n1. OT claimed is 186 hours.  Kindly remove it.\n\nThe lines are given role wise.";
  it("finds a quote across whitespace and case", () => {
    const at = locate(msg, "ot claimed is 186 hours. kindly remove it.")!;
    expect(msg.slice(at[0], at[1])).toBe("OT claimed is 186 hours.  Kindly remove it.");
  });
  it("returns null for a quote that is not there", () => {
    expect(locate(msg, "nothing like this")).toBeNull();
  });
  it("cuts at every boundary and lets spans overlap", () => {
    const segs = segmentMessage(msg, [
      { key: "C1", quote: "OT claimed is 186 hours." },
      { key: "rule:0", quote: "186 hours" },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(msg);
    const inner = segs.find((s) => s.text === "186 hours")!;
    expect(inner.keys.sort()).toEqual(["C1", "rule:0"]);
    expect(segs.find((s) => s.text.startsWith("Dear"))!.keys).toEqual([]);
  });
});

describe("receivedOn", () => {
  it("reads the Date header", () => {
    expect(receivedOn("From: x\nDate: Mon, 6 Oct 2026, 7:42 PM\nSubject: y")).toBe("2026-10-06");
  });
  it("falls back to today without one", () => {
    expect(receivedOn("no header", new Date("2026-10-11T08:00:00Z"))).toBe("2026-10-11");
  });
});

describe("pre-send view on the demo ledger", () => {
  let dir: string;
  const saved = { state: process.env.STATE_DIR, seed: process.env.LEDGER_SEED };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "presend-view-"));
    process.env.STATE_DIR = dir;
    process.env.LEDGER_SEED = String(DEMO_SEED);
  });
  afterAll(() => {
    process.env.STATE_DIR = saved.state;
    if (saved.seed === undefined) delete process.env.LEDGER_SEED;
    else process.env.LEDGER_SEED = saved.seed;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetState();
    resetApp();
  });

  it("opens the October draft with two decisions and two fixes already made", () => {
    const v = buildPresendView("INV-2026-0863");
    expect(v.needs.map((n) => n.rule_id)).toEqual(["MER-R5", "MER-R6"]);
    expect(v.verdict.tone).toBe("hold");
    expect(v.handled[0]).toMatchObject({ kind: "formats" });
    expect(v.sendable).toBe(false);
    // The headline money is the engine's: both proposals, combined.
    expect(v.verdict.money).toBeGreaterThan(0);
    expect(v.now.total).toBe(v.base.total);
  });

  it("proposes quantities from the annexure, never a typed amount", () => {
    const w = workingDraft("INV-2026-0863");
    const report = buildPreSendReport({ invoice: w.current.invoice, buyer: w.buyer, annexure: w.current.annexure }, w.rules);
    const ot = report.business.find((i) => i.finding.rule_id === "MER-R5")!;
    const p = proposeFor(ot, w.rules.find((r) => r.rule_id === "MER-R5"), w.current)!;
    expect(p.primary).toBe("Hold OT");
    expect(p.calls.every((c) => c.tool === "adjust_line" && c.value === 0)).toBe(true);
    // And the engine accepts them only as the merchant.
    expect(applyToolCall(w.current, p.calls[0], { actor: "model" }).result.ok).toBe(false);
  });

  it("a saved approval closes its finding and moves the total", () => {
    const before = buildPresendView("INV-2026-0863");
    const w = workingDraft("INV-2026-0863");
    const report = buildPreSendReport({ invoice: w.current.invoice, buyer: w.buyer, annexure: w.current.annexure }, w.rules);
    const item = report.business.find((i) => i.finding.rule_id === "MER-R5")!;
    const p = proposeFor(item, w.rules.find((r) => r.rule_id === "MER-R5"), w.current)!;
    saveRecord("INV-2026-0863", {
      approved: [{ rule_id: "MER-R5", title: p.title, resolved: p.resolved, note: p.note, line_ids: ["L9", "L10", "L11"], calls: p.calls, wage_cut: 0, total_cut: 0, at: "2026-10-11" }],
    });
    expect(loadRecord("INV-2026-0863").approved).toHaveLength(1);
    const after = buildPresendView("INV-2026-0863");
    expect(after.needs.map((n) => n.rule_id)).toEqual(["MER-R6"]);
    expect(after.now.total).toBeLessThan(before.now.total);
    expect(after.held!.wages).toBe(23085);
  });

  it("reads a sent or disputed invoice without offering to change it", () => {
    const v = buildPresendView("INV-2026-0847");
    expect(v.read_only).toBe(true);
    expect(v.needs.every((n) => n.primary === null && n.keep === null)).toBe(true);
    expect(v.verdict.tone).toBe("as_sent");
  });
});
