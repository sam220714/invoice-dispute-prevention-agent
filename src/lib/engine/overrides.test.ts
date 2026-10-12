import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadSplit } from "../data/load";
import { DEMO_SEED } from "../data/split";
import type { Annexure, Override } from "../schema";
import {
  applyOverrides, fingerprintFinding, OverrideError, recordOverride, revokeOverride, staleSignal, STALE_AFTER,
} from "./overrides";
import { buildPreSendReport } from "./presend";
import { applyToolCall, createDraft } from "./tools";

const rules = loadSplit(DEMO_SEED).context;
const NOW = new Date("2026-10-11T10:00:00Z");

const rawReport = (invoiceId: string, annexure?: Annexure | null) => {
  const invoice = getInvoice(invoiceId);
  return buildPreSendReport({ invoice, buyer: getBuyer(invoice.buyer_id), annexure: annexure ?? loadAnnexure(invoiceId) }, rules);
};

/** The October draft after the automatic format fixes, as the pre-send screen shows it. */
const fixedOctober = () => {
  const invoice = getInvoice("INV-2026-0863");
  const buyer = getBuyer(invoice.buyer_id);
  const annexure = loadAnnexure(invoice.invoice_id);
  const { draft } = applyToolCall(createDraft({ invoice, buyer, annexure, rules }), { tool: "apply_template" }, { actor: "engine" });
  return buildPreSendReport({ invoice: draft.invoice, buyer, annexure: draft.annexure }, rules);
};

const ruleIds = (items: { rule: { rule_id: string } }[]) => items.map((i) => i.rule.rule_id);

describe("overriding a business finding", () => {
  const report = fixedOctober();

  it("starts with two business items open", () => {
    expect(ruleIds(report.business)).toEqual(["MER-R3", "MER-R4"]);
    expect(report.can_send_as_is).toBe(false);
  });

  it("waives it for this invoice, keeps the reason, and leaves the other item open", () => {
    const { overrides } = recordOverride([], report, { rule_id: "MER-R3", reason: "verbal OT approval", by: "Sunita Reddy", now: NOW });
    const view = applyOverrides(report, overrides);
    expect(ruleIds(view.business)).toEqual(["MER-R4"]);
    expect(view.overridden).toHaveLength(1);
    expect(view.overridden[0]!.override).toMatchObject({
      invoice_id: "INV-2026-0863", buyer_id: "BUY-MERIDIAN", rule_id: "MER-R3", reason: "verbal OT approval", by: "Sunita Reddy",
      bucket: "business", kind: "finding", at: NOW.toISOString(),
    });
    expect(view.sendable).toBe(false);
  });

  it("leaves nothing open once both are waived, and the invoice can go with its format fixes", () => {
    const a = recordOverride([], report, { rule_id: "MER-R3", now: NOW });
    const b = recordOverride(a.overrides, report, { rule_id: "MER-R4", now: NOW });
    const view = applyOverrides(report, b.overrides);
    expect(view.business).toEqual([]);
    expect(view.format).toEqual([]);
    expect(view.can_send_as_is).toBe(true);
    expect(view.sendable).toBe(true);
    expect(view.overridden.map((o) => o.override.rule_id)).toEqual(["MER-R3", "MER-R4"]);
    expect(view.foreseen_by).toEqual([]);
  });

  it("does not change the rule, the report it was given, or the overrides it was given", () => {
    const ledgerBefore = JSON.stringify(rules);
    const reportBefore = JSON.stringify(report);
    const list: Override[] = [];
    const { overrides } = recordOverride(list, report, { rule_id: "MER-R3", now: NOW });
    applyOverrides(report, overrides);
    expect(JSON.stringify(rules)).toBe(ledgerBefore);
    expect(JSON.stringify(report)).toBe(reportBefore);
    expect(list).toEqual([]);
  });

  it("is for one invoice: the same rule is still flagged on another", () => {
    const { overrides } = recordOverride([], report, { rule_id: "MER-R3", now: NOW });
    const sept = applyOverrides(rawReport("INV-2026-0847"), overrides);
    expect(ruleIds(sept.business)).toEqual(["MER-R3", "MER-R4"]);
    expect(sept.overridden).toEqual([]);
  });

  it("makes the reason optional, trims it, and treats blank as none", () => {
    const get = (reason?: string | null) => recordOverride([], report, { rule_id: "MER-R4", reason, now: NOW }).override.reason;
    expect(get()).toBeNull();
    expect(get("   ")).toBeNull();
    expect(get("")).toBeNull();
    expect(get("  contract amended in August  ")).toBe("contract amended in August");
  });

  it("overriding again replaces the earlier override instead of adding a second", () => {
    const first = recordOverride([], report, { rule_id: "MER-R3", reason: "first", now: NOW });
    const second = recordOverride(first.overrides, report, { rule_id: "MER-R3", reason: "second", now: new Date("2026-10-12T10:00:00Z") });
    expect(second.overrides).toHaveLength(1);
    expect(second.overrides[0]!.reason).toBe("second");
  });

  it("can be taken back, and then the finding is open again", () => {
    const { overrides } = recordOverride([], report, { rule_id: "MER-R3", now: NOW });
    const back = revokeOverride(overrides, "INV-2026-0863", "MER-R3");
    expect(back.removed).toBe(true);
    expect(ruleIds(applyOverrides(report, back.overrides).business)).toEqual(["MER-R3", "MER-R4"]);
    expect(revokeOverride(back.overrides, "INV-2026-0863", "MER-R3").removed).toBe(false);
  });

  it("brings the finding back if the invoice changed since it was waived", () => {
    const { overrides } = recordOverride([], report, { rule_id: "MER-R4", reason: "both left on the 30th", now: NOW });
    // One of the two workers is now billed fewer days, so the finding no longer reads the same.
    const annexure = structuredClone(loadAnnexure("INV-2026-0863")!);
    annexure.rows.find((r) => r.last_working_day && r.days_billed > 30)!.days_billed -= 1;
    const changed = rawReport("INV-2026-0863", annexure);
    const view = applyOverrides(changed, overrides);
    expect(fingerprintFinding(changed.business.find((i) => i.rule.rule_id === "MER-R4")!.finding)).not.toBe(overrides[0]!.fingerprint);
    expect(ruleIds(view.business)).toContain("MER-R4");
    expect(view.reopened).toEqual(["MER-R4"]);
    expect(view.overridden).toEqual([]);
  });
});

describe("format fixes cannot be overridden", () => {
  const raw = rawReport("INV-2026-0863"); // the draft as it stands: MER-R1 and MER-R2 are open

  it("refuses to override an open format finding, and says why", () => {
    expect(ruleIds(raw.format)).toEqual(["MER-R1", "MER-R2"]);
    expect(() => recordOverride([], raw, { rule_id: "MER-R1", now: NOW })).toThrow(OverrideError);
    expect(() => recordOverride([], raw, { rule_id: "MER-R1", now: NOW })).toThrow(/format rule.*cannot be overridden/);
  });

  it("refuses a format rule the linter could only flag for a person", () => {
    expect(() => recordOverride([], rawReport("INV-2026-0849"), { rule_id: "YOG-R5", now: NOW })).toThrow(/format rule/);
  });

  it("ignores a format override record even if one is forged into the list", () => {
    const forged: Override = {
      invoice_id: "INV-2026-0863", buyer_id: "BUY-MERIDIAN", rule_id: "MER-R1", bucket: "format", kind: "finding",
      fingerprint: fingerprintFinding(raw.format[0]!.finding), summary: "forged", reason: null, by: null, at: NOW.toISOString(),
    };
    const view = applyOverrides(raw, [forged]);
    expect(ruleIds(view.format)).toEqual(["MER-R1", "MER-R2"]);
    expect(view.overridden).toEqual([]);
  });
});

describe("nothing to override", () => {
  it("refuses a rule that passed, and one that does not exist", () => {
    const fixed = fixedOctober();
    expect(ruleIds(fixed.format)).toEqual([]);
    expect(() => recordOverride([], fixed, { rule_id: "MER-R1", now: NOW })).toThrow(/Nothing to override/);
    expect(() => recordOverride([], fixed, { rule_id: "MER-R99", now: NOW })).toThrow(OverrideError);
  });
});

describe("manual-review items", () => {
  const yogita = rawReport("INV-2026-0849");

  it("can be marked as reviewed, like a business finding", () => {
    expect(yogita.manual.map((m) => m.rule_id)).toContain("YOG-R1");
    const { override, overrides } = recordOverride([], yogita, { rule_id: "YOG-R1", reason: "checked the attendance register", now: NOW });
    expect(override).toMatchObject({ kind: "manual_review", bucket: "business", buyer_id: "BUY-YOGITA" });
    const view = applyOverrides(yogita, overrides);
    expect(view.manual.map((m) => m.rule_id)).not.toContain("YOG-R1");
    expect(view.overridden.map((o) => o.override.rule_id)).toEqual(["YOG-R1"]);
  });

  it("never block sending, with or without an override", () => {
    expect(applyOverrides(yogita, []).sendable).toBe(true);
  });
});

describe("the stale-rule signal", () => {
  const ov = (invoice_id: string, at: string, reason: string | null = null): Override => ({
    invoice_id, buyer_id: "BUY-MERIDIAN", rule_id: "MER-R3", bucket: "business", kind: "finding", fingerprint: "x", summary: "s", reason, by: null, at,
  });

  it("is absent until a rule has been overridden", () => {
    expect(staleSignal([], "MER-R3")).toBeNull();
  });

  it("is only a note after one override, and a warning after STALE_AFTER different invoices", () => {
    expect(STALE_AFTER).toBe(2);
    const one = staleSignal([ov("INV-A", "2026-10-01T00:00:00Z")], "MER-R3")!;
    expect(one).toMatchObject({ overridden_on: ["INV-A"], may_be_out_of_date: false });
    const two = staleSignal([ov("INV-A", "2026-10-01T00:00:00Z"), ov("INV-B", "2026-10-02T00:00:00Z")], "MER-R3")!;
    expect(two).toMatchObject({ overridden_on: ["INV-A", "INV-B"], may_be_out_of_date: true });
  });

  it("counts invoices, not clicks", () => {
    const s = staleSignal([ov("INV-A", "2026-10-01T00:00:00Z"), ov("INV-A", "2026-10-02T00:00:00Z")], "MER-R3")!;
    expect(s.overridden_on).toEqual(["INV-A"]);
    expect(s.may_be_out_of_date).toBe(false);
  });

  it("carries the latest reason given", () => {
    const s = staleSignal([ov("INV-A", "2026-10-01T00:00:00Z", "phone approval"), ov("INV-B", "2026-10-02T00:00:00Z", "new contract"), ov("INV-C", "2026-10-03T00:00:00Z")], "MER-R3")!;
    expect(s.last_reason).toBe("new contract");
  });

  it("is shown beside a finding that is still open, so the merchant sees it before overriding again", () => {
    const view = applyOverrides(fixedOctober(), [ov("INV-A", "2026-10-01T00:00:00Z"), ov("INV-B", "2026-10-02T00:00:00Z")]);
    expect(ruleIds(view.business)).toContain("MER-R3");
    expect(view.signals["MER-R3"]).toMatchObject({ may_be_out_of_date: true, overridden_on: ["INV-A", "INV-B"] });
    expect(view.signals["MER-R4"]).toBeUndefined();
  });

  it("never switches a rule off or touches the ledger", () => {
    const before = JSON.stringify(rules);
    applyOverrides(fixedOctober(), [ov("INV-A", "2026-10-01T00:00:00Z"), ov("INV-B", "2026-10-02T00:00:00Z")]);
    expect(JSON.stringify(rules)).toBe(before);
    expect(rules.find((r) => r.rule_id === "MER-R3")!.status).toBe("active");
  });
});
