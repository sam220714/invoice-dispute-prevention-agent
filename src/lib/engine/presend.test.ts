import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadSplit } from "../data/load";
import { DEMO_SEED } from "../data/split";
import type { Invoice, Rule } from "../schema";
import { buildPreSendReport } from "./presend";

// The ledger the demo starts from: 12 of the 15 rules. MER-R2, MER-R4 and YOG-R5 are not in it yet.
const seed = loadSplit(DEMO_SEED).context;
const report = (invoice: Invoice, rules: Rule[] = seed) =>
  buildPreSendReport(
    { invoice, buyer: getBuyer(invoice.buyer_id), annexure: loadAnnexure(invoice.invoice_id) },
    rules,
  );
const ids = (items: { rule: { rule_id: string } }[]) => items.map((i) => i.rule.rule_id);

describe("pre-send report: October draft (INV-2026-0863)", () => {
  const r = report(getInvoice("INV-2026-0863"));

  it("is the headline: 2 business lines to review, 2 format fixes", () => {
    expect(ids(r.business)).toEqual(["MER-R5", "MER-R6"]);
    expect(ids(r.format)).toEqual(["MER-R1", "MER-R3"]);
  });

  it("cannot be sent as it stands", () => {
    expect(r.can_send_as_is).toBe(false);
  });

  it("flags only the overtime lines at sites that billed more than was authorised", () => {
    const ot = r.business.find((i) => i.rule.rule_id === "MER-R5")!;
    expect(ot.finding.line_ids).toEqual(["L9", "L10", "L11"]);
    expect(ot.finding.facts.unreferenced_hours).toBe(171);
  });

  it("traces every finding to the past disputes that taught the rule", () => {
    expect(r.foreseen_by).toEqual(["DSP-001", "DSP-002", "DSP-004", "DSP-006", "DSP-008"]);
    expect(r.business[0]!.rule.learned_from).toEqual(["DSP-004"]);
  });

  it("buckets keep their own autonomy level", () => {
    expect(r.business.every((i) => i.finding.autonomy === "propose_merchant_approves")).toBe(true);
    expect(r.format.every((i) => i.finding.autonomy === "auto_apply")).toBe(true);
  });

  it("states no merchant-facing regex", () => {
    const text = JSON.stringify(r.format.map((i) => i.finding.message));
    expect(text).not.toContain("\\d");
  });

  it("the 1st-5th window passes on a draft dated 3 Nov, once the rule is in the ledger", () => {
    const withWindow = [...seed, ...loadSplit(DEMO_SEED).heldOut.filter((x) => x.rule_id === "MER-R4")];
    expect(report(getInvoice("INV-2026-0863"), withWindow).passed.map((p) => p.rule_id)).toContain("MER-R4");
  });

  it("a held-out grouping rule would flag the role-wise lines", () => {
    const withGrouping = [...seed, ...loadSplit(DEMO_SEED).heldOut.filter((x) => x.rule_id === "MER-R2")];
    const hit = report(getInvoice("INV-2026-0863"), withGrouping).format.find((i) => i.rule.rule_id === "MER-R2");
    expect(hit?.finding.facts.interleaved_sites).toEqual(["Shamshabad Hub", "Medchal DC", "Patancheru Yard"]);
  });
});

describe("pre-send report: other buyers", () => {
  it("Yogita: nothing to fix, three items for a human, two passes", () => {
    const r = report(getInvoice("INV-2026-0849"));
    expect(r.business).toEqual([]);
    expect(r.format).toEqual([]);
    expect(r.manual.map((m) => m.rule_id)).toEqual(["YOG-R1", "YOG-R3", "YOG-R6"]);
    expect(r.passed.map((p) => p.rule_id)).toEqual(["YOG-R2", "YOG-R4"]);
    // Manual items are advisory; they do not block.
    expect(r.can_send_as_is).toBe(true);
  });

  it("reports only the rules for the invoice's own buyer", () => {
    const r = report(getInvoice("INV-2026-0852"));
    const all = [...r.business, ...r.format].map((i) => i.rule.rule_id);
    expect(all.every((id) => id.startsWith("TEA-"))).toBe(true);
    expect(r.passed.map((p) => p.rule_id)).toEqual(["TEA-R2"]);
  });
});

describe("pre-send report: the ledger drives the result", () => {
  it("a disabled rule stops being checked", () => {
    const off = seed.map((x) => (x.rule_id === "MER-R1" ? { ...x, status: "disabled" as const } : x));
    expect(ids(report(getInvoice("INV-2026-0863"), off).format)).toEqual(["MER-R3"]);
  });

  it("an empty ledger finds nothing, which is the point of having one", () => {
    const r = report(getInvoice("INV-2026-0863"), []);
    expect(r.can_send_as_is).toBe(true);
    expect(r.foreseen_by).toEqual([]);
  });
});
