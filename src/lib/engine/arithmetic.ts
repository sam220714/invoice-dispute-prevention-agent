import type { Invoice, InvoiceLine, ServiceChargeBase, Totals } from "../schema";

/**
 * The only place in the system that produces a money figure.
 *
 * The model emits intents like adjust_line("L7", "qty", 24). It never emits an
 * amount, and no total here is ever read back out of a prompt. All arithmetic
 * is integer paise with half-up rounding, applied in the same component order
 * as the dataset's own verify script: wages -> PF -> ESI -> service charge -> taxable ->
 * CGST -> SGST -> grand total.
 */

// Rates in basis points (1/100 of a percent), so every product stays an integer.
const PF_BP = 1300; //  13%    employer PF (12% + 1% admin/EDLI)
const ESI_BP = 325; //   3.25% employer ESI
const CGST_BP = 900; //  9%
const SGST_BP = 900; //  9%
const BP = 10_000;

export type Paise = number;

export const toPaise = (rupees: number): Paise => Math.round(rupees * 100);
export const toRupees = (paise: Paise): number => paise / 100;

/** Integer division rounding half away from zero. */
function divRound(n: number, d: number): number {
  const sign = n < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(n) * 2 + d) / (2 * d));
}

const applyBp = (paise: Paise, bp: number): Paise => divRound(paise * bp, BP);

export const lineAmountPaise = (line: Pick<InvoiceLine, "qty" | "rate">): Paise =>
  Math.round(line.qty * line.rate * 100);

export interface ChargeTerms {
  /** Service charge as a fraction, e.g. 0.07 for 7%. */
  service_charge_pct: number;
  service_charge_base: ServiceChargeBase;
}

export function computeTotals(lines: Pick<InvoiceLine, "qty" | "rate">[], terms: ChargeTerms): Totals {
  const wages = lines.reduce((sum, l) => sum + lineAmountPaise(l), 0);
  const pf = applyBp(wages, PF_BP);
  const esi = applyBp(wages, ESI_BP);
  const basis = terms.service_charge_base === "wages_only" ? wages : wages + pf + esi;
  const chargeBp = Math.round(terms.service_charge_pct * BP);
  const serviceCharge = applyBp(basis, chargeBp);
  const taxable = wages + pf + esi + serviceCharge;
  const cgst = applyBp(taxable, CGST_BP);
  const sgst = applyBp(taxable, SGST_BP);

  return {
    wages: toRupees(wages),
    pf_employer: toRupees(pf),
    esi_employer: toRupees(esi),
    service_charge: toRupees(serviceCharge),
    service_charge_pct: terms.service_charge_pct,
    service_charge_base: terms.service_charge_base,
    service_charge_basis_amount: toRupees(basis),
    taxable_value: toRupees(taxable),
    cgst: toRupees(cgst),
    sgst: toRupees(sgst),
    grand_total: toRupees(taxable + cgst + sgst),
  };
}

/**
 * Recompute every line amount and every total from qty x rate. Returns a new
 * invoice; the input is untouched. Terms default to the ones already on the
 * invoice, and can be overridden to apply the buyer's contract (e.g. when the
 * service-charge base was wrong).
 */
export function recomputeInvoice(invoice: Invoice, terms?: Partial<ChargeTerms>): Invoice {
  const effective: ChargeTerms = {
    service_charge_pct: terms?.service_charge_pct ?? invoice.totals.service_charge_pct,
    service_charge_base: terms?.service_charge_base ?? invoice.totals.service_charge_base,
  };
  const lines = invoice.lines.map((l) => ({ ...l, amount: toRupees(lineAmountPaise(l)) }));
  return { ...invoice, lines, totals: computeTotals(lines, effective) };
}

export interface TotalsDelta {
  wage_reduction_inr: number;
  total_reduction_inr: number;
  revised_total_inr: number;
  original_total_inr: number;
}

/** What a set of edits did to an invoice, in rupees, computed in paise. */
export function compareInvoices(before: Invoice, after: Invoice): TotalsDelta {
  const b = before.totals;
  const a = after.totals;
  return {
    wage_reduction_inr: toRupees(toPaise(b.wages) - toPaise(a.wages)),
    total_reduction_inr: toRupees(toPaise(b.grand_total) - toPaise(a.grand_total)),
    revised_total_inr: a.grand_total,
    original_total_inr: b.grand_total,
  };
}
