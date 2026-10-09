import { describe, expect, it } from "vitest";
import { getInvoice, loadInvoices } from "../data/load";
import { compareInvoices, computeTotals, recomputeInvoice, toPaise } from "./arithmetic";

const paise = (n: number) => toPaise(n);

// dataset/generate.py rounds half-up on integer paise, exactly as the engine does,
// so every stored invoice must reproduce to the paisa with no tolerance.

describe("recomputeInvoice", () => {
  it.each(loadInvoices().map((i) => [i.invoice_id, i] as const))(
    "%s reproduces every stored line amount and total",
    (id, invoice) => {
      const out = recomputeInvoice(invoice);
      for (const [i, line] of out.lines.entries()) {
        expect(paise(line.amount), `${line.line_id} amount`).toBe(paise(invoice.lines[i]!.amount));
      }
      for (const key of [
        "wages",
        "pf_employer",
        "esi_employer",
        "service_charge",
        "service_charge_basis_amount",
        "taxable_value",
        "cgst",
        "sgst",
        "grand_total",
      ] as const) {
        const diff = Math.abs(paise(out.totals[key]) - paise(invoice.totals[key]));
        expect(diff, `${key} differs by ${diff} paise`).toBe(0);
      }
    },
  );

  it("every invoice matches its stored totals exactly", () => {
    for (const { invoice_id: id } of loadInvoices()) {
      const invoice = getInvoice(id);
      expect(recomputeInvoice(invoice).totals).toEqual(invoice.totals);
    }
  });

  it("does not mutate its input", () => {
    const invoice = getInvoice("INV-2026-0847");
    const snapshot = structuredClone(invoice);
    const edited = { ...invoice, lines: invoice.lines.map((l) => ({ ...l, qty: l.qty + 1 })) };
    recomputeInvoice(edited);
    expect(invoice).toEqual(snapshot);
  });

  it("is idempotent", () => {
    const once = recomputeInvoice(getInvoice("INV-2026-0849"));
    expect(recomputeInvoice(once)).toEqual(once);
  });

  it("changing a quantity changes the total, and only via qty x rate", () => {
    const invoice = getInvoice("INV-2026-0847");
    const edited = recomputeInvoice({
      ...invoice,
      lines: invoice.lines.map((l) => (l.line_id === "L9" ? { ...l, qty: 40 } : l)),
    });
    expect(edited.lines.find((l) => l.line_id === "L9")!.amount).toBe(40 * 135);
    expect(edited.totals.grand_total).toBeLessThan(invoice.totals.grand_total);
  });
});

describe("service-charge base", () => {
  const lines = [{ qty: 100, rate: 1000 }];

  it("wages_only charges on wages alone", () => {
    const t = computeTotals(lines, { service_charge_pct: 0.07, service_charge_base: "wages_only" });
    expect(t.service_charge_basis_amount).toBe(100_000);
    expect(t.service_charge).toBe(7_000);
  });

  it("wages_plus_statutory charges on wages + PF + ESI", () => {
    const t = computeTotals(lines, {
      service_charge_pct: 0.07,
      service_charge_base: "wages_plus_statutory",
    });
    // 100,000 + 13,000 PF + 3,250 ESI = 116,250
    expect(t.service_charge_basis_amount).toBe(116_250);
    expect(t.service_charge).toBe(8_137.5);
  });

  it("splits GST evenly into CGST and SGST at 9% each", () => {
    const t = computeTotals(lines, { service_charge_pct: 0.07, service_charge_base: "wages_only" });
    expect(t.cgst).toBe(t.sgst);
    expect(paise(t.cgst)).toBe(Math.round(paise(t.taxable_value) * 0.09));
  });
});

describe("compareInvoices", () => {
  it("reports reductions in rupees with no float drift", () => {
    const before = getInvoice("INV-2026-0847");
    const after = recomputeInvoice({
      ...before,
      lines: before.lines.map((l) => (l.line_id === "L9" ? { ...l, qty: 0 } : l)),
    });
    const delta = compareInvoices(before, after);
    expect(delta.wage_reduction_inr).toBe(54 * 135);
    expect(paise(delta.original_total_inr) - paise(delta.revised_total_inr)).toBe(
      paise(delta.total_reduction_inr),
    );
  });
});
