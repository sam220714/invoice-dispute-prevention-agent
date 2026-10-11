/**
 * HARNESS, NOT RUNTIME. What the right tool calls are for each case in the
 * tool-call eval. The demo's come from the answer key; the rest are worked out
 * from the data and say below where.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpectedCall } from "./toolcalls_judge";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oracle = JSON.parse(readFileSync(join(root, "dataset", "qa", "expected_analysis.json"), "utf-8")) as {
  revised_invoice_total_inr: number;
};

export const DEMO_REVISED_TOTAL = oracle.revised_invoice_total_inr;

/** expected_analysis.json: adjust_line(L9, qty, 0); adjust_line(L11, qty, 0); adjust_line(L6, qty, 520); set_field x2; regroup_lines. */
export const DEMO_CALLS: ExpectedCall[] = [
  { tool: "adjust_line", bucket: "business", line_id: "L9", field: "qty", value: 0 },
  { tool: "adjust_line", bucket: "business", line_id: "L11", field: "qty", value: 0 },
  { tool: "adjust_line", bucket: "business", line_id: "L6", field: "qty", value: 520 },
  {
    tool: "set_field", bucket: "format", field: "po_number",
    viaTemplate: (d) => !!d.invoice.po_number && d.invoice.lines.every((l) => l.po_number === d.invoice.po_number),
  },
  {
    tool: "set_field", bucket: "format", field: "sac",
    viaTemplate: (d) => !!d.invoice.sac && d.invoice.lines.every((l) => l.sac === d.invoice.sac),
  },
  { tool: "regroup_lines", bucket: "format", group_by: "site_code" },
];

export interface SingleCase {
  dispute: string;
  buyer: string;
  /** Why this is the right answer, so a surprising verdict can be argued with. */
  why: string;
  expected: ExpectedCall[];
}

/**
 * Old disputes raised against the buyer's latest sent invoice (a standing decision: the dataset has no
 * older invoices). Each needs exactly one tool call, so a miss is unambiguous.
 *
 * Left out on purpose: DSP-011 (Yogita is already on wages_only, so the right answer is no call at all)
 * and DSP-008 (it says the loaders left on 20 May; the annexure has them leaving in September).
 */
export const SINGLES: SingleCase[] = [
  {
    dispute: "DSP-004",
    buyer: "BUY-MERIDIAN",
    why: "No overtime authorisation for Patancheru. The annexure authorises none there, and L11 is Patancheru's overtime line (the demo's second claim).",
    expected: [{ tool: "adjust_line", bucket: "business", line_id: "L11", field: "qty", value: 0 }],
  },
  {
    dispute: "DSP-007",
    buyer: "BUY-MERIDIAN",
    why: "Group the lines site-wise: regroup_lines on site_code, the same call as the demo's fifth claim.",
    expected: [{ tool: "regroup_lines", bucket: "format", group_by: "site_code" }],
  },
];
