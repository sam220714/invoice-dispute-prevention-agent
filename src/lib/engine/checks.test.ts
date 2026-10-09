import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadRulePool } from "../data/load";
import type { CheckResult, Invoice, Rule } from "../schema";
import { runChecks, type CheckContext } from "./checks";
import { RULE_CHECKS } from "./seed_checks";

// The whole pool, so every kind of check is exercised whatever the seed would put in context.
const pool = loadRulePool();

const ctxFor = (invoice: Invoice): CheckContext => ({
  invoice,
  buyer: getBuyer(invoice.buyer_id),
  annexure: loadAnnexure(invoice.invoice_id),
});

const run = (invoiceId: string, rules: Rule[] = pool) => runChecks(ctxFor(getInvoice(invoiceId)), rules);
const byOutcome = (results: CheckResult[], outcome: CheckResult["outcome"]) =>
  results.filter((r) => r.outcome === outcome).map((r) => r.rule_id).sort();
const find = (results: CheckResult[], id: string) => results.find((r) => r.rule_id === id)!;

/** Rules built here by hand to exercise the linter. */
const rule = (over: Partial<Rule> & Pick<Rule, "rule_id" | "check">): Rule => ({
  buyer_id: "BUY-MERIDIAN",
  type: "format",
  rule: "test rule",
  confidence: "medium",
  learned_from: ["DSP-TEST"],
  status: "active",
  times_corroborated: 1,
  ...over,
});

describe("rule pool coverage", () => {
  it("every rule in the pool has a check, and RULE_CHECKS has no extras", () => {
    expect(Object.keys(RULE_CHECKS).sort()).toEqual(pool.map((r) => r.rule_id).sort());
  });

  it("only business and format rules exist", () => {
    expect(new Set(pool.map((r) => r.type))).toEqual(new Set(["business", "format"]));
  });
});

describe("Meridian, September (the demo invoice, INV-2026-0847)", () => {
  const results = run("INV-2026-0847");

  it("fails exactly the rules the dispute was about, and passes the portal window", () => {
    expect(byOutcome(results, "fail")).toEqual(["MER-R1", "MER-R2", "MER-R3", "MER-R5", "MER-R6"]);
    expect(byOutcome(results, "pass")).toEqual(["MER-R4"]);
  });

  it("routes each failure by bucket to the right autonomy level", () => {
    const f = (id: string) => find(results, id).finding!;
    expect(f("MER-R5").autonomy).toBe("propose_merchant_approves");
    expect(f("MER-R6").autonomy).toBe("propose_merchant_approves");
    expect(f("MER-R1").autonomy).toBe("auto_apply");
    expect(f("MER-R2").autonomy).toBe("auto_apply");
  });

  it("OT: 146 hours unreferenced, on the Shamshabad and Patancheru lines only", () => {
    const f = find(results, "MER-R5").finding!;
    expect(f.facts.unreferenced_hours).toBe(146);
    expect(f.line_ids).toEqual(["L9", "L11"]); // Medchal's 40 hours are all authorised
  });

  it("exits: 20 man-days over, on the Shamshabad loader line only", () => {
    const f = find(results, "MER-R6").finding!;
    expect(f.facts.excess_man_days).toBe(20);
    expect(f.line_ids).toEqual(["L6"]);
    expect(f.facts.workers).toEqual([
      "Shaik Imran: 12 days over (billed 30, last day 2026-09-18)",
      "Bhaskar Rao Gundu: 8 days over (billed 30, last day 2026-09-22)",
    ]);
  });

  it("grouping: the lines are role-wise, so every site is split across the invoice", () => {
    const f = find(results, "MER-R2").finding!;
    expect(f.facts.interleaved_sites).toEqual(["Shamshabad Hub", "Medchal DC", "Patancheru Yard"]);
  });

  it("carries no rupee figure anywhere in a finding", () => {
    const blob = JSON.stringify(results.map((r) => r.finding));
    expect(blob).not.toMatch(/\bRs\b|₹|inr|amount|total/i);
  });
});

describe("Meridian, October draft (the pre-send check target, INV-2026-0863)", () => {
  const results = run("INV-2026-0863");

  it("catches the same defects September was disputed for", () => {
    expect(byOutcome(results, "fail")).toEqual(["MER-R1", "MER-R2", "MER-R3", "MER-R5", "MER-R6"]);
  });

  it("OT: all 171 hours are unreferenced, on all three site lines", () => {
    const f = find(results, "MER-R5").finding!;
    expect(f.facts.unreferenced_hours).toBe(171);
    expect(f.line_ids).toEqual(["L9", "L10", "L11"]);
  });

  it("exits: 25 man-days over (17 + 8)", () => {
    expect(find(results, "MER-R6").finding!.facts.excess_man_days).toBe(25);
  });
});

describe("check kinds, exercised by hand-built rules", () => {
  const window = rule({ rule_id: "T-WINDOW", check: { kind: "invoice_date_window", from_day: 1, to_day: 5 } });
  const grouped = rule({ rule_id: "T-GROUP", check: { kind: "lines_grouped_by", field: "site_code" } });
  const po = rule({ rule_id: "T-PO", check: { kind: "line_field_required", field: "po_number" } });

  it("invoice_date_window passes on 3 Nov (inside the 1st-5th window)", () => {
    expect(find(run("INV-2026-0863", [window]), "T-WINDOW").outcome).toBe("pass");
  });

  it("invoice_date_window fails once the invoice is dated 9 Nov", () => {
    const late = { ...getInvoice("INV-2026-0863"), invoice_date: "2026-11-09" };
    const r = runChecks(ctxFor(late), [window])[0]!;
    expect(r.outcome).toBe("fail");
    expect(r.finding!.message).toContain("1st-5th");
  });

  it("lines_grouped_by passes once the lines are sorted by site", () => {
    const base = getInvoice("INV-2026-0863");
    const order = ["SH", "MD", "PY"];
    const sorted = { ...base, lines: [...base.lines].sort((a, b) => order.indexOf(a.site_code) - order.indexOf(b.site_code)) };
    expect(runChecks(ctxFor(sorted), [grouped])[0]!.outcome).toBe("pass");
    expect(runChecks(ctxFor(base), [grouped])[0]!.outcome).toBe("fail");
  });

  it("line_field_required passes once the PO is on every line, and names the lines that lack it", () => {
    const base = getInvoice("INV-2026-0863");
    const bad = runChecks(ctxFor(base), [po])[0]!;
    expect(bad.outcome).toBe("fail");
    expect(bad.finding!.line_ids).toHaveLength(base.lines.length);
    const filled = { ...base, lines: base.lines.map((l) => ({ ...l, po_number: base.po_number })) };
    expect(runChecks(ctxFor(filled), [po])[0]!.outcome).toBe("pass");
  });
});

describe("Yogita (INV-2026-0849)", () => {
  const results = run("INV-2026-0849");

  it("passes the cycle and service-charge-base rules", () => {
    expect(byOutcome(results, "pass")).toEqual(["YOG-R2", "YOG-R4"]);
  });

  it("finds nothing to fix", () => {
    expect(byOutcome(results, "fail")).toEqual([]);
  });

  it("surfaces unmechanisable rules for a human instead of dropping them", () => {
    expect(byOutcome(results, "manual")).toEqual(["YOG-R1", "YOG-R3", "YOG-R5", "YOG-R6"]);
    expect(find(results, "YOG-R1").note).toContain("gate register");
  });

  it("YOG-R4 fails if the service charge is on the wrong base", () => {
    const wrong = getInvoice("INV-2026-0849");
    const bad = { ...wrong, totals: { ...wrong.totals, service_charge_base: "wages_plus_statutory" as const } };
    expect(find(runChecks(ctxFor(bad), pool), "YOG-R4").outcome).toBe("fail");
  });
});

describe("Teamlease (INV-2026-0852)", () => {
  const results = run("INV-2026-0852");

  it("passes the 45-day terms rule", () => {
    expect(find(results, "TEA-R2").outcome).toBe("pass");
  });

  it("fails TEA-R2 if the invoice states 30 days", () => {
    const inv = { ...getInvoice("INV-2026-0852"), due_date: "2026-11-01" };
    const r = find(runChecks(ctxFor(inv), pool), "TEA-R2");
    expect(r.outcome).toBe("fail");
    expect(r.finding!.facts.stated_days).toBe(30);
  });
});

describe("runChecks edge cases", () => {
  it("only applies rules belonging to the invoice's buyer", () => {
    const ids = run("INV-2026-0847").map((r) => r.rule_id);
    expect(ids.every((id) => id.startsWith("MER-"))).toBe(true);
  });

  it("drops disabled rules entirely", () => {
    const off = pool.map((r) => (r.rule_id === "MER-R1" ? { ...r, status: "disabled" as const } : r));
    expect(run("INV-2026-0847", off).some((r) => r.rule_id === "MER-R1")).toBe(false);
  });

  it("reports 'cannot verify' rather than passing when the annexure is missing", () => {
    const ctx = { ...ctxFor(getInvoice("INV-2026-0863")), annexure: null };
    const results = runChecks(ctx, pool);
    for (const id of ["MER-R5", "MER-R6"]) {
      const r = find(results, id);
      expect(r.outcome).toBe("manual");
      expect(r.note).toContain("cannot be verified");
    }
  });

  it("degrades to manual on an invalid pattern instead of throwing", () => {
    const bad = rule({ rule_id: "T-BAD", check: { kind: "line_field_matches", field: "description", pattern: "(" } });
    const r = run("INV-2026-0847", [bad])[0]!;
    expect(r.outcome).toBe("manual");
  });

  it("a rule with no check is surfaced for manual review", () => {
    const { check: _omit, ...bare } = rule({ rule_id: "T-NOCHECK", check: undefined as never });
    expect(runChecks(ctxFor(getInvoice("INV-2026-0847")), [bare as Rule])[0]!.outcome).toBe("manual");
  });
});
