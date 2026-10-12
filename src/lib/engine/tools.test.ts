import { describe, expect, it } from "vitest";
import { getBuyer, getInvoice, loadAnnexure, loadSplit } from "../data/load";
import { DEMO_SEED } from "../data/split";
import type { Rule } from "../schema";
import { recomputeInvoice } from "./arithmetic";
import { runChecks } from "./checks";
import {
  applyToolCall,
  createDraft,
  previewImpact,
  type Actor,
  type Draft,
  type ToolResult,
} from "./tools";

// The ledger the demo starts from: MER-R1 (PO per line) and MER-R2 (SAC per line) are in it.
const seed = loadSplit(DEMO_SEED).context;

/** Rules that are not in the demo ledger yet, built by hand to exercise the tools. */
const groupRule: Rule = {
  rule_id: "T-GROUP", buyer_id: "BUY-MERIDIAN", type: "format", rule: "test rule",
  confidence: "medium", learned_from: ["DSP-TEST"], status: "active",
  times_corroborated: 1, check: { kind: "lines_grouped_by", field: "site_code" },
};
const windowRule: Rule = {
  ...groupRule, rule_id: "T-WINDOW",
  check: { kind: "invoice_date_window", from_day: 1, to_day: 5 },
};

const open = (invoiceId: string, rules: Rule[] = seed): Draft => {
  const invoice = getInvoice(invoiceId);
  return createDraft({ invoice, buyer: getBuyer(invoice.buyer_id), annexure: loadAnnexure(invoiceId), rules });
};

const call = (d: Draft, raw: unknown, actor: Actor = "merchant") => applyToolCall(d, raw, { actor });
const text = (r: ToolResult) => (r.ok ? r.message : r.error);
const line = (d: Draft, id: string) => d.invoice.lines.find((l) => l.line_id === id)!;

// L9 is Shamshabad overtime: 54 hours at Rs 135.
const PO = "MLP/PO/2026/3318";

// --------------------------------------------------------------- the contract
describe("the contract", () => {
  it("refuses business tools for the model and the engine, allows the merchant", () => {
    const d = open("INV-2026-0847");
    const ask = { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "unauthorised OT" };
    for (const actor of ["model", "engine"] as const) {
      const r = call(d, ask, actor);
      expect(r.result.ok).toBe(false);
      expect(text(r.result)).toContain("approval_required");
      expect(line(r.draft, "L9").qty).toBe(54);
    }
    expect(call(d, ask, "merchant").result.ok).toBe(true);
  });

  it("lets the model apply format tools directly", () => {
    const d = open("INV-2026-0863");
    expect(call(d, { tool: "set_field", field: "sac", value: "998519" }, "model").result.ok).toBe(true);
    expect(call(d, { tool: "regroup_lines", group_by: "site_code" }, "model").result.ok).toBe(true);
  });

  it("has no evidence tools: a task cannot be raised", () => {
    const task = { tool: "create_task", owner: "compliance", description: "Attach Sep challans", due_date: "2026-11-03" };
    const r = call(open("INV-2026-0863"), task, "model");
    expect(r.result.ok).toBe(false);
    expect(text(r.result)).toContain('unknown tool "create_task"');
  });

  it("rejects a call that smuggles in a money field, rather than stripping it", () => {
    const d = open("INV-2026-0847");
    for (const extra of [{ amount: 99999 }, { total: 1 }, { grand_total: 2 }]) {
      const r = call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "x", ...extra });
      expect(r.result.ok).toBe(false);
      expect(text(r.result)).toMatch(/unrecognized/i);
    }
  });

  it("allows adjust_line on qty only, never on rate", () => {
    const d = open("INV-2026-0847");
    const r = call(d, { tool: "adjust_line", line_id: "L9", field: "rate", value: 1, reason: "x" });
    expect(r.result.ok).toBe(false);
    expect(line(r.draft, "L9").rate).toBe(135);
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "40"],
  ])("rejects a %s quantity", (_n, value) => {
    const d = open("INV-2026-0847");
    expect(call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value, reason: "x" }).result.ok).toBe(false);
  });

  it("rejects an unknown tool by name, and junk input, and never passes silently", () => {
    const d = open("INV-2026-0847");
    const unknown = call(d, { tool: "refund_everything" });
    expect(text(unknown.result)).toContain('unknown tool "refund_everything"');
    for (const junk of [null, undefined, "adjust_line", 42, {}, []]) {
      expect(call(d, junk).result.ok).toBe(false);
    }
  });

  it("never mutates the draft it is given", () => {
    const d = open("INV-2026-0847");
    const snapshot = structuredClone(d);
    call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "x" });
    call(d, { tool: "remove_line", line_id: "L1", reason: "x" });
    call(d, { tool: "nonsense" });
    expect(d).toEqual(snapshot);
  });

  it("keeps the baseline fixed however much the invoice changes", () => {
    let d = open("INV-2026-0847");
    d = call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "x" }).draft;
    expect(d.baseline.totals.grand_total).toBe(getInvoice("INV-2026-0847").totals.grand_total);
    expect(d.invoice.totals.grand_total).toBeLessThan(d.baseline.totals.grand_total);
  });

  it("logs every call, rejected ones included, in order, with the engine's total", () => {
    let d = open("INV-2026-0847");
    d = call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value: 20, reason: "OT" }).draft;
    d = call(d, { tool: "adjust_line", line_id: "L99", field: "qty", value: 1, reason: "x" }).draft;
    d = call(d, { tool: "nonsense" }, "model").draft;
    expect(d.log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(d.log.map((e) => e.status)).toEqual(["applied", "rejected", "rejected"]);
    expect(d.log[0]!.actor).toBe("merchant");
    expect(d.log[2]!.actor).toBe("model");
    expect(d.log[0]!.grand_total_after).toBe(d.invoice.totals.grand_total);
    // A rejection changes nothing, so the total after it is unchanged.
    expect(d.log[1]!.grand_total_after).toBe(d.log[0]!.grand_total_after);
  });
});

// ------------------------------------------------------------ business tools
describe("business tools", () => {
  it("adjust_line changes qty and the engine recomputes every figure", () => {
    const d = open("INV-2026-0847");
    const r = call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value: 20, reason: "only 20 hours authorised" });
    expect(r.result.ok).toBe(true);
    expect(line(r.draft, "L9").amount).toBe(2700);
    const expected = recomputeInvoice({
      ...d.invoice,
      lines: d.invoice.lines.map((l) => (l.line_id === "L9" ? { ...l, qty: 20 } : l)),
    });
    expect(r.draft.invoice.totals).toEqual(expected.totals);
  });

  it("is a no-op when the quantity is already right", () => {
    const d = open("INV-2026-0847");
    const r = call(d, { tool: "adjust_line", line_id: "L9", field: "qty", value: 54, reason: "x" });
    expect(r.result).toMatchObject({ ok: true, status: "noop" });
  });

  it("rejects an unknown line", () => {
    const r = call(open("INV-2026-0847"), { tool: "adjust_line", line_id: "L99", field: "qty", value: 1, reason: "x" });
    expect(text(r.result)).toContain('unknown line_id "L99"');
  });

  it("requires a reason", () => {
    const r = call(open("INV-2026-0847"), { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "  " });
    expect(r.result.ok).toBe(false);
  });

  it("remove_line removes a line and lowers the total", () => {
    const d = open("INV-2026-0847");
    const r = call(d, { tool: "remove_line", line_id: "L9", reason: "unauthorised" });
    expect(r.draft.invoice.lines).toHaveLength(10);
    expect(r.draft.invoice.totals.grand_total).toBeLessThan(d.invoice.totals.grand_total);
  });

  it("will not empty an invoice", () => {
    const base = open("INV-2026-0847");
    const one = createDraft({
      invoice: { ...base.invoice, lines: [base.invoice.lines[0]!] },
      buyer: base.buyer, annexure: null, rules: seed,
    });
    expect(text(call(one, { tool: "remove_line", line_id: "L1", reason: "x" }).result)).toContain("only line");
  });

  it("defer_line moves a line to a later period and keeps it on record", () => {
    const r = call(open("INV-2026-0847"), { tool: "defer_line", line_id: "L9", to_period: "2026-10", reason: "next cycle" });
    expect(r.result.ok).toBe(true);
    expect(r.draft.invoice.lines.some((l) => l.line_id === "L9")).toBe(false);
    expect(r.draft.deferred).toHaveLength(1);
    expect(r.draft.deferred[0]).toMatchObject({ to_period: "2026-10", line: { line_id: "L9", qty: 54 } });
  });

  it("defer_line refuses the current or an earlier period, and a malformed one", () => {
    const d = open("INV-2026-0847");
    for (const to_period of ["2026-09", "2026-08", "2026-9", "Oct 2026"]) {
      expect(call(d, { tool: "defer_line", line_id: "L9", to_period, reason: "x" }).result.ok).toBe(false);
    }
  });

  describe("split_invoice", () => {
    const split = (d: Draft, ids: string[]) => call(d, { tool: "split_invoice", disputed_line_ids: ids });

    it("separates a disputed portion so the rest can be collected", () => {
      const d = open("INV-2026-0847");
      const r = split(d, ["L9", "L11"]);
      expect(r.result.ok).toBe(true);
      expect(r.draft.held!.lines.map((l) => l.line_id)).toEqual(["L9", "L11"]);
      expect(r.draft.invoice.lines).toHaveLength(9);
      expect(r.draft.held!.invoice_id).toBe("INV-2026-0847-HELD");
    });

    it("conserves wages exactly across the two halves", () => {
      const d = open("INV-2026-0847");
      const r = split(d, ["L9", "L11"]);
      expect(r.draft.invoice.totals.wages + r.draft.held!.totals.wages).toBe(d.invoice.totals.wages);
    });

    it("refuses to split off every line, or to split twice", () => {
      const d = open("INV-2026-0847");
      expect(split(d, d.invoice.lines.map((l) => l.line_id)).result.ok).toBe(false);
      const once = split(d, ["L9"]).draft;
      expect(text(split(once, ["L10"]).result)).toContain("already split");
    });

    it("then refuses to edit a line that is on the held portion", () => {
      const once = split(open("INV-2026-0847"), ["L9"]).draft;
      const r = call(once, { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "x" });
      expect(text(r.result)).toContain("held portion");
    });
  });
});

describe("set_service_charge_base", () => {
  const ask = (value: string) => ({ tool: "set_service_charge_base", value, reason: "the contract says so" });

  it("is a business tool: the model cannot apply it, the merchant can", () => {
    const d = open("INV-2026-0852");
    expect(text(call(d, ask("wages_only"), "model").result)).toContain("approval_required");
    expect(call(d, ask("wages_only"), "merchant").result.ok).toBe(true);
  });

  it("switches the base and the engine recomputes the charge, never the caller", () => {
    const d = open("INV-2026-0852"); // Teamlease is billed on wages plus statutory
    const r = call(d, ask("wages_only"), "merchant");
    expect(r.draft.invoice.totals.service_charge_base).toBe("wages_only");
    expect(r.draft.invoice.totals.service_charge).toBeLessThan(d.invoice.totals.service_charge);
    expect(r.draft.invoice.totals.grand_total).toBeLessThan(d.invoice.totals.grand_total);
    expect(r.draft.invoice.totals.service_charge_basis_amount).toBe(d.invoice.totals.wages);
  });

  it("is a no-op when the base is already right", () => {
    expect(call(open("INV-2026-0849"), ask("wages_only"), "merchant").result).toMatchObject({ ok: true, status: "noop" });
  });

  it("rejects a base that does not exist, and carries no amount", () => {
    expect(call(open("INV-2026-0852"), ask("wages_and_gst"), "merchant").result.ok).toBe(false);
    expect(call(open("INV-2026-0852"), { ...ask("wages_only"), amount: 1 }, "merchant").result.ok).toBe(false);
  });
});

// ------------------------------------------------------------- format tools
describe("format tools", () => {
  it("set_field po_number accepts only the invoice's own PO number", () => {
    const d = open("INV-2026-0863");
    const good = call(d, { tool: "set_field", field: "po_number", value: PO, line_id: "L1" }, "model");
    expect(line(good.draft, "L1").po_number).toBe(PO);
    expect(line(good.draft, "L2").po_number).toBeNull();
    const wrong = call(d, { tool: "set_field", field: "po_number", value: "MLP/PO/2026/0001", line_id: "L1" }, "model");
    expect(text(wrong.result)).toContain("does not match the invoice's PO");
  });

  it("set_field po_number without a line writes it to every line, once", () => {
    const d = open("INV-2026-0863");
    const r = call(d, { tool: "set_field", field: "po_number", value: PO }, "model");
    expect(r.draft.invoice.lines.every((l) => l.po_number === PO)).toBe(true);
    expect(call(r.draft, { tool: "set_field", field: "po_number", value: PO }, "model").result).toMatchObject({ status: "noop" });
  });

  it("set_field sac writes the invoice's SAC to every line, once", () => {
    const d = open("INV-2026-0863");
    const r = call(d, { tool: "set_field", field: "sac", value: "998519" }, "model");
    expect(r.draft.invoice.lines.every((l) => l.sac === "998519")).toBe(true);
    expect(call(r.draft, { tool: "set_field", field: "sac", value: "998519" }, "model").result).toMatchObject({ status: "noop" });
    expect(call(d, { tool: "set_field", field: "sac", value: "123456" }, "model").result.ok).toBe(false);
  });

  it("set_field refuses the fields v1 dropped", () => {
    const d = open("INV-2026-0863");
    for (const field of ["cost_centre", "employee_code_column"]) {
      expect(call(d, { tool: "set_field", field, value: "x" }, "model").result.ok).toBe(false);
    }
  });

  it("regroup_lines orders by site, keeps the order within a site, and is idempotent", () => {
    const base = open("INV-2026-0863");
    const r = call(base, { tool: "regroup_lines", group_by: "site_code" }, "model");
    expect(r.result).toMatchObject({ ok: true, status: "applied" });
    expect(r.draft.invoice.lines.map((l) => l.site_code)).toEqual(["SH", "SH", "SH", "SH", "MD", "MD", "MD", "MD", "PY", "PY", "PY"]);
    // Within Shamshabad the role order of the original is kept: guard, housekeeping, loader, overtime.
    expect(r.draft.invoice.lines.slice(0, 4).map((l) => l.line_id)).toEqual(["L1", "L4", "L6", "L9"]);
    expect(call(r.draft, { tool: "regroup_lines", group_by: "site_code" }, "model").result).toMatchObject({ status: "noop" });
  });

  it("regroup_lines refuses a grouping v1 does not have", () => {
    expect(call(open("INV-2026-0863"), { tool: "regroup_lines", group_by: "cost_centre" }, "model").result.ok).toBe(false);
  });

  describe("apply_template on the October draft", () => {
    const rules = [...seed, groupRule];
    const d = open("INV-2026-0863", rules);
    const r = call(d, { tool: "apply_template" }, "model");
    const after = runChecks({ invoice: r.draft.invoice, buyer: r.draft.buyer, annexure: r.draft.annexure }, r.draft.rules);
    const outcome = (id: string) => after.find((x) => x.rule_id === id)!;

    it("fixes everything an invoice edit can fix", () => {
      expect(r.result.ok).toBe(true);
      for (const id of ["MER-R1", "MER-R2", "T-GROUP"]) expect(outcome(id).outcome, id).toBe("pass");
    });

    it("leaves nothing for a person once every format rule is mechanical", () => {
      const data = r.result.ok ? (r.result.data as { unresolved: unknown[] }) : null;
      expect(data!.unresolved).toEqual([]);
    });

    it("does not touch the business findings", () => {
      for (const id of ["MER-R3", "MER-R4"]) expect(outcome(id).outcome).toBe("fail");
    });

    it("never changes a rupee: format fixes are not billing changes", () => {
      expect(r.draft.invoice.totals).toEqual(d.invoice.totals);
    });

    it("logs the umbrella call and each primitive, as the engine", () => {
      const tools = r.draft.log.map((e) => e.tool);
      expect(tools[0]).toBe("apply_template");
      expect(tools.filter((t) => t === "set_field").length).toBe(2); // PO, SAC
      expect(tools.filter((t) => t === "regroup_lines").length).toBe(1);
      expect(r.draft.log.slice(1).every((e) => e.actor === "engine")).toBe(true);
    });

    it("is idempotent: a second run applies nothing new", () => {
      const again = call(r.draft, { tool: "apply_template" }, "model");
      expect(again.draft.log.filter((e) => e.status === "applied").length).toBe(
        r.draft.log.filter((e) => e.status === "applied").length,
      );
    });
  });

  it("apply_template reports a rule it cannot apply as an edit instead of faking it", () => {
    const late = { ...getInvoice("INV-2026-0863"), invoice_date: "2026-11-09" };
    const d = createDraft({ invoice: late, buyer: getBuyer("BUY-MERIDIAN"), annexure: null, rules: [windowRule] });
    const r = call(d, { tool: "apply_template" }, "model");
    const data = r.result.ok ? (r.result.data as { unresolved: { rule_id: string; reason: string }[] }) : null;
    expect(data!.unresolved).toEqual([expect.objectContaining({ rule_id: "T-WINDOW" })]);
    expect(data!.unresolved[0]!.reason).toContain("not an edit");
    expect(r.draft.invoice.invoice_date).toBe("2026-11-09");
  });

  it("apply_template is a no-op on an invoice that already conforms", () => {
    const d = createDraft({ ...open("INV-2026-0863"), rules: [], annexure: null });
    expect(call(d, { tool: "apply_template" }, "model").result).toMatchObject({ status: "noop" });
  });
});

// -------------------------------------------------------------------- reads
describe("read tools", () => {
  it("validate_against_spec reports failing, manual and passing counts", () => {
    const r = call(open("INV-2026-0849"), { tool: "validate_against_spec" }, "model");
    const data = r.result.ok ? (r.result.data as { failing: unknown[]; manual: number; passing: number }) : null;
    expect([data!.failing.length, data!.manual, data!.passing]).toEqual([0, 3, 2]);
  });

  it("reads change nothing", () => {
    const d = open("INV-2026-0863");
    const r = call(d, { tool: "validate_against_spec" }, "model");
    expect(r.draft.invoice).toEqual(d.invoice);
    expect(r.draft.log).toHaveLength(1);
  });

  it("recompute_invoice returns the engine's totals", () => {
    const d = open("INV-2026-0847");
    const r = call(d, { tool: "recompute_invoice" }, "model");
    expect(r.result.ok && r.result.data).toEqual(d.invoice.totals);
  });
});

// ---------------------------------------------------------------- preview
describe("previewImpact", () => {
  const otSh = { tool: "adjust_line", line_id: "L9", field: "qty", value: 0, reason: "OT" };
  const otPy = { tool: "adjust_line", line_id: "L11", field: "qty", value: 0, reason: "OT" };
  const exits = { tool: "adjust_line", line_id: "L6", field: "qty", value: 520, reason: "exits" };

  it("prices the proposals without applying them", () => {
    const d = open("INV-2026-0847");
    const snapshot = structuredClone(d);
    const { delta } = previewImpact(d, [otSh, otPy, exits]);
    expect(delta.wage_reduction_inr).toBe(33310);
    expect(d).toEqual(snapshot);
  });

  it("reports a bad proposal alongside the good ones", () => {
    const { results, delta } = previewImpact(open("INV-2026-0847"), [otSh, { ...exits, line_id: "L99" }]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(delta.wage_reduction_inr).toBe(54 * 135);
  });
});
