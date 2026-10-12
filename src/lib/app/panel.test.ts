import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getInvoice, loadLedger, loadRulePool, resetState, saveLedger } from "../data/load";
import { DEMO_SEED } from "../data/split";
import { focusOfCall, focusOfCheck, isGroupedBySite, panelHead, shownFields, type FormatFocus } from "./panel";
import { buildPresendView } from "./presend_view";
import { loadRecord, resetApp, saveRecord } from "./store";

describe("what a format rule acts on", () => {
  it("maps a rule's check to the part of the invoice it governs", () => {
    expect(focusOfCheck({ kind: "line_field_required", field: "po_number" })).toBe("po");
    expect(focusOfCheck({ kind: "line_field_required", field: "sac" })).toBe("sac");
    expect(focusOfCheck({ kind: "lines_grouped_by", field: "site_code" })).toBe("group");
    expect(focusOfCheck({ kind: "invoice_date_window", from_day: 1, to_day: 5 })).toBe("window");
    expect(focusOfCheck({ kind: "service_charge_base", expected: "wages_only" })).toBeNull();
    expect(focusOfCheck(undefined)).toBeNull();
  });

  it("maps a format tool call the same way", () => {
    expect(focusOfCall({ tool: "set_field", field: "po_number", value: "x" })).toBe("po");
    expect(focusOfCall({ tool: "set_field", field: "sac", value: "x" })).toBe("sac");
    expect(focusOfCall({ tool: "regroup_lines", group_by: "site_code" })).toBe("group");
    expect(focusOfCall({ tool: "apply_template" })).toBeNull();
  });
});

describe("the header strip", () => {
  const inv = getInvoice("INV-2026-0863");
  const window = { from_day: 1, to_day: 5 };

  it("says the invoice is inside the portal window when it is", () => {
    const h = panelHead({ ...inv, invoice_date: "2026-11-03" }, "Meridian", window);
    expect(h.window).toEqual({ ok: true, text: "Inside Meridian's 1st–5th portal window" });
    expect(h.date).toBe("3 Nov 2026");
    expect(h.po).toBe(inv.po_number);
  });

  it("says so when it is outside, on either side of the window", () => {
    expect(panelHead({ ...inv, invoice_date: "2026-11-06" }, "Meridian", window).window?.ok).toBe(false);
    expect(panelHead({ ...inv, invoice_date: "2026-10-31" }, "Meridian", window).window?.text).toContain("Outside");
  });

  it("shows no chip when no rule enforces a window", () => {
    expect(panelHead(inv, "Meridian", null).window).toBeNull();
  });
});

describe("the invoice panel's before and after, on the demo ledger", () => {
  let dir: string;
  const saved = { state: process.env.STATE_DIR, seed: process.env.LEDGER_SEED };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "panel-view-"));
    process.env.STATE_DIR = dir;
    process.env.LEDGER_SEED = String(DEMO_SEED);
    process.env.LEDGER_RULES = "12";
  });
  afterAll(() => {
    process.env.STATE_DIR = saved.state;
    if (saved.seed === undefined) delete process.env.LEDGER_SEED;
    else process.env.LEDGER_SEED = saved.seed;
    delete process.env.LEDGER_RULES;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetState();
    resetApp();
  });

  it("shows the PO and SAC blank as drafted and filled in after the fix", () => {
    const v = buildPresendView("INV-2026-0863");
    const po = getInvoice("INV-2026-0863").po_number;
    expect(v.lines.every((l) => l.po0 === null && l.sac0 === null)).toBe(true);
    expect(v.lines.every((l) => l.po1 === po && l.sac1 === "998519")).toBe(true);
  });

  it("does not regroup the lines, or show a window, until the ledger has learned those rules", () => {
    const v = buildPresendView("INV-2026-0863");
    expect(v.grouped0).toBe(false);
    expect(v.grouped).toBe(false);
    expect(v.head.window).toBeNull();
    const fixes = v.handled[0]!.kind === "formats" ? v.handled[0]!.fixes : [];
    expect(fixes.map((f) => f.focus)).toEqual(["po", "sac"]);
  });

  it("regroups the lines and shows the window once those two rules are in the ledger", () => {
    saveLedger(loadRulePool());
    const v = buildPresendView("INV-2026-0863");
    expect(v.grouped0).toBe(false);
    expect(v.grouped).toBe(true);
    expect(v.head.window).toMatchObject({ ok: true });
    const fixes = v.handled[0]!.kind === "formats" ? v.handled[0]!.fixes : [];
    expect(fixes.map((f) => f.focus).sort()).toEqual(["group", "po", "sac"]);
  });

  it("keeps the as-drafted order, so the panel can put the lines back role-wise", () => {
    saveLedger(loadRulePool());
    const v = buildPresendView("INV-2026-0863");
    const drafted = getInvoice("INV-2026-0863").lines.map((l) => l.line_id);
    expect([...v.lines].sort((a, b) => a.pos0 - b.pos0).map((l) => l.line_id)).toEqual(drafted);
    expect(v.lines.map((l) => l.line_id)).not.toEqual(drafted);
  });

  it("leaves the PO blank when that rule is switched off", () => {
    saveLedger(loadLedger().map((r) => (r.rule_id === "MER-R1" ? { ...r, status: "disabled" as const } : r)));
    const v = buildPresendView("INV-2026-0863");
    expect(v.lines.every((l) => l.po1 === null)).toBe(true);
    expect(v.lines.every((l) => l.sac1 === "998519")).toBe(true);
  });

  it("changes no amount: a format fix is a different view of the same money", () => {
    const v = buildPresendView("INV-2026-0863");
    expect(v.lines.every((l) => l.qty0 === l.qty1 && l.amount0 === l.amount1)).toBe(true);
    expect(v.base.total).toBe(v.now.total);
  });
});

describe("site grouping", () => {
  it("tells a role-wise invoice from a site-wise one", () => {
    const inv = getInvoice("INV-2026-0863");
    expect(isGroupedBySite(inv)).toBe(false);
    const sorted = { ...inv, lines: [...inv.lines].sort((a, b) => a.site_code.localeCompare(b.site_code)) };
    expect(isGroupedBySite(sorted)).toBe(true);
  });
});

describe("a format fix switched off for one invoice", () => {
  const line = { po0: null, po1: "PO-1", sac0: null, sac1: "998519", pos0: 3 };
  const only = (...on: FormatFocus[]) => (f: FormatFocus) => on.includes(f);

  it("shows the fix when it is in force and the draft when it is not", () => {
    expect(shownFields(line, only("po", "sac"))).toEqual({ po: "PO-1", sac: "998519", poFixed: true, sacFixed: true });
    expect(shownFields(line, only("sac"))).toEqual({ po: null, sac: "998519", poFixed: false, sacFixed: true });
    expect(shownFields(line, only())).toEqual({ po: null, sac: null, poFixed: false, sacFixed: false });
  });

  it("marks nothing as fixed on a line the fix did not change", () => {
    const same = { po0: "PO-1", po1: "PO-1", sac0: "998519", sac1: "998519", pos0: 0 };
    expect(shownFields(same, only("po", "sac"))).toMatchObject({ poFixed: false, sacFixed: false });
  });
});

describe("the pre-send view with a fix switched off", () => {
  let dir: string;
  const saved = { state: process.env.STATE_DIR, seed: process.env.LEDGER_SEED };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "format-off-"));
    process.env.STATE_DIR = dir;
    process.env.LEDGER_SEED = String(DEMO_SEED);
    process.env.LEDGER_RULES = "12";
  });
  afterAll(() => {
    process.env.STATE_DIR = saved.state;
    if (saved.seed === undefined) delete process.env.LEDGER_SEED;
    else process.env.LEDGER_SEED = saved.seed;
    delete process.env.LEDGER_RULES;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetState();
    resetApp();
  });
  const off = (...ids: string[]) => saveRecord("INV-2026-0863", { ...loadRecord("INV-2026-0863"), format_off: ids });
  const fixesOf = (v: ReturnType<typeof buildPresendView>) => {
    const h = v.handled.find((x) => x.kind === "formats");
    return h && h.kind === "formats" ? h : null;
  };

  it("applies every format fix by default", () => {
    const h = fixesOf(buildPresendView("INV-2026-0863"))!;
    expect(h.fixes.map((f) => f.on)).toEqual([true, true]);
    expect(h.heading).toBe("2 format fixes applied");
  });

  it("leaves that part of the invoice as drafted, and says how many fixes are on", () => {
    off("MER-R1");
    const v = buildPresendView("INV-2026-0863");
    expect(v.lines.every((l) => l.po1 === null)).toBe(true);
    expect(v.lines.every((l) => l.sac1 === "998519")).toBe(true);
    const h = fixesOf(v)!;
    expect(h.fixes.find((f) => f.rule_id === "MER-R1")!.on).toBe(false);
    expect(h.fixes.find((f) => f.rule_id === "MER-R2")!.on).toBe(true);
    expect(h.heading).toBe("1 of 2 format fixes applied");
  });

  it("does not turn the fix into a new open finding, and does not touch the decisions to make", () => {
    off("MER-R1", "MER-R2");
    const v = buildPresendView("INV-2026-0863");
    expect(v.needs.map((n) => n.rule_id)).toEqual(["MER-R3", "MER-R4"]);
    expect(v.lines.every((l) => l.po1 === null && l.sac1 === null)).toBe(true);
    expect(v.base.total).toBe(v.now.total);
  });

  it("puts the fix back when it is switched on again, and never edits the rule", () => {
    const rulesBefore = JSON.stringify(loadLedger());
    off("MER-R1");
    off();
    const v = buildPresendView("INV-2026-0863");
    expect(v.lines.every((l) => l.po1 !== null)).toBe(true);
    expect(JSON.stringify(loadLedger())).toBe(rulesBefore);
  });
});
