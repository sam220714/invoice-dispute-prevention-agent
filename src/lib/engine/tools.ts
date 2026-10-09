import { z } from "zod";
import { ServiceChargeBaseSchema, type Annexure, type Buyer, type Invoice, type InvoiceLine, type Rule } from "../schema";
import { compareInvoices, recomputeInvoice, type TotalsDelta } from "./arithmetic";
import { runChecks } from "./checks";

/**
 * The agent's tool surface, over an immutable draft.
 *
 * Three properties are enforced here rather than left to convention:
 *  - A call can carry no money. Every schema is strict, so an `amount` or
 *    `total` key is rejected instead of silently dropped. Money exists only
 *    as recomputeInvoice() output, refreshed after every change.
 *  - Business tools touch revenue, so they run only for the merchant. A model
 *    or engine actor that asks for one is refused.
 *  - Every call is logged, rejected ones included. The audit trail for "why did
 *    this change?" is a by-product of running at all.
 *
 * The draft is bound to one invoice, so tools take no invoice_id or buyer_id:
 * one less thing for a model to get wrong.
 */

// ------------------------------------------------------------------- schema
export const LineId = z.string().trim().min(1).max(40);
export const Reason = z.string().trim().min(1).max(500);
export const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

export const ToolCallSchema = z.discriminatedUnion("tool", [
  // business: touches revenue, merchant approves
  z.object({ tool: z.literal("adjust_line"), line_id: LineId, field: z.literal("qty"), value: z.number().finite().nonnegative(), reason: Reason }).strict(),
  z.object({ tool: z.literal("remove_line"), line_id: LineId, reason: Reason }).strict(),
  z.object({ tool: z.literal("defer_line"), line_id: LineId, to_period: Period, reason: Reason }).strict(),
  z.object({ tool: z.literal("split_invoice"), disputed_line_ids: z.array(LineId).min(1) }).strict(),
  z.object({ tool: z.literal("set_service_charge_base"), value: ServiceChargeBaseSchema, reason: Reason }).strict(),
  // format: deterministic once learned, auto-apply
  z.object({
    tool: z.literal("set_field"),
    field: z.enum(["po_number", "sac"]),
    value: z.string().trim().min(1).max(100),
    line_id: LineId.optional(),
  }).strict(),
  z.object({ tool: z.literal("regroup_lines"), group_by: z.literal("site_code") }).strict(),
  z.object({ tool: z.literal("apply_template") }).strict(),
  // reads
  z.object({ tool: z.literal("recompute_invoice") }).strict(),
  z.object({ tool: z.literal("validate_against_spec") }).strict(),
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolName = ToolCall["tool"];
type CallOf<K extends ToolName> = Extract<ToolCall, { tool: K }>;

export const TOOL_KIND: Record<ToolName, "business" | "format" | "read"> = {
  adjust_line: "business",
  remove_line: "business",
  defer_line: "business",
  split_invoice: "business",
  set_service_charge_base: "business",
  set_field: "format",
  regroup_lines: "format",
  apply_template: "format",
  recompute_invoice: "read",
  validate_against_spec: "read",
};

// -------------------------------------------------------------------- draft
export type Actor = "model" | "engine" | "merchant";

export interface DeferredLine {
  line: InvoiceLine;
  to_period: string;
  reason: string;
}

export interface LogEntry {
  seq: number;
  tool: string;
  args: unknown;
  actor: Actor;
  status: "applied" | "noop" | "read" | "rejected";
  message: string;
  /** The invoice's grand total after this call, as produced by recomputeInvoice(). */
  grand_total_after: number;
}

export interface Draft {
  /** The invoice as it was when the draft was opened. Never modified. */
  readonly baseline: Invoice;
  readonly invoice: Invoice;
  /** The disputed portion, once split_invoice has run. */
  readonly held: Invoice | null;
  readonly annexure: Annexure | null;
  readonly buyer: Buyer;
  readonly rules: Rule[];
  readonly deferred: DeferredLine[];
  readonly log: LogEntry[];
}
type MutableDraft = { -readonly [K in keyof Draft]: Draft[K] };

export function createDraft(input: {
  invoice: Invoice;
  buyer: Buyer;
  annexure: Annexure | null;
  rules: Rule[];
}): Draft {
  return structuredClone({
    baseline: input.invoice,
    invoice: input.invoice,
    held: null,
    annexure: input.annexure,
    buyer: input.buyer,
    rules: input.rules,
    deferred: [],
    log: [],
  });
}

// ------------------------------------------------------------------- result
export type ToolResult =
  | { ok: true; status: "applied" | "noop" | "read"; message: string; data?: unknown }
  | { ok: false; status: "rejected"; error: string };

export interface ApplyOptions {
  actor: Actor;
}

class ToolError extends Error {}
const refuse = (message: string): never => {
  throw new ToolError(message);
};

interface Outcome {
  status: "applied" | "noop" | "read";
  message: string;
  data?: unknown;
  /** Primitive calls an umbrella tool expands into; each is applied and logged on its own. */
  expand?: ToolCall[];
}
const applied = (message: string, data?: unknown): Outcome => ({ status: "applied", message, data });
const noop = (message: string): Outcome => ({ status: "noop", message });
const read = (message: string, data?: unknown): Outcome => ({ status: "read", message, data });

// ------------------------------------------------------------------ helpers
function findLine(w: MutableDraft, lineId: string): InvoiceLine {
  const line = w.invoice.lines.find((l) => l.line_id === lineId);
  if (line) return line;
  if (w.held?.lines.some((l) => l.line_id === lineId))
    return refuse(`${lineId} is on the held portion after split_invoice`);
  return refuse(`unknown line_id "${lineId}"`);
}

function refresh(w: MutableDraft): void {
  w.invoice = recomputeInvoice(w.invoice);
  if (w.held) w.held = recomputeInvoice(w.held);
}

const checkContext = (w: MutableDraft) => ({ invoice: w.invoice, buyer: w.buyer, annexure: w.annexure });

function removeLine(w: MutableDraft, lineId: string): InvoiceLine {
  const line = findLine(w, lineId);
  if (w.invoice.lines.length === 1)
    refuse("that is the only line; cancel the invoice instead of emptying it");
  w.invoice.lines = w.invoice.lines.filter((l) => l.line_id !== lineId);
  return line;
}

// ----------------------------------------------------------------- handlers
const HANDLERS: { [K in ToolName]: (w: MutableDraft, c: CallOf<K>) => Outcome } = {
  // ---- business
  adjust_line(w, c) {
    const line = findLine(w, c.line_id);
    if (line.qty === c.value) return noop(`${c.line_id} qty is already ${c.value}`);
    const before = line.qty;
    line.qty = c.value;
    return applied(`${c.line_id} qty ${before} -> ${c.value}: ${c.reason}`, {
      line_id: c.line_id, before, after: c.value,
    });
  },

  remove_line(w, c) {
    const removed = removeLine(w, c.line_id);
    return applied(`removed ${c.line_id} (${removed.description}): ${c.reason}`);
  },

  defer_line(w, c) {
    if (c.to_period <= w.invoice.period_end.slice(0, 7))
      refuse(`to_period ${c.to_period} is not after this invoice's period`);
    const removed = removeLine(w, c.line_id);
    w.deferred.push({ line: removed, to_period: c.to_period, reason: c.reason });
    return applied(`deferred ${c.line_id} to ${c.to_period}: ${c.reason}`);
  },

  split_invoice(w, c) {
    if (w.held) refuse("this invoice is already split");
    const ids = [...new Set(c.disputed_line_ids)];
    for (const id of ids) findLine(w, id);
    if (ids.length === w.invoice.lines.length) refuse("every line is disputed; there is nothing to release");
    const heldLines = w.invoice.lines.filter((l) => ids.includes(l.line_id));
    w.held = { ...structuredClone(w.invoice), invoice_id: `${w.invoice.invoice_id}-HELD`, lines: heldLines };
    w.invoice.lines = w.invoice.lines.filter((l) => !ids.includes(l.line_id));
    return applied(`split off ${ids.join(", ")} into ${w.held.invoice_id}; no credit note is issued`);
  },

  set_service_charge_base(w, c) {
    if (w.invoice.totals.service_charge_base === c.value)
      return noop(`the service charge is already on ${c.value}`);
    const before = w.invoice.totals.service_charge_base;
    // refresh() recomputes every figure from this base, so no amount is typed in here.
    w.invoice.totals = { ...w.invoice.totals, service_charge_base: c.value };
    if (w.held) w.held.totals = { ...w.held.totals, service_charge_base: c.value };
    return applied(`service charge base ${before} -> ${c.value}: ${c.reason}`, { before, after: c.value });
  },

  // ---- format
  set_field(w, c) {
    if (c.field === "po_number") {
      if (c.value !== w.invoice.po_number)
        return refuse(`PO ${c.value} does not match the invoice's PO ${w.invoice.po_number}`);
      const targets = c.line_id ? [findLine(w, c.line_id)] : w.invoice.lines;
      const todo = targets.filter((l) => l.po_number !== c.value);
      if (!todo.length) return noop("the PO number is already on every targeted line");
      for (const l of todo) l.po_number = c.value;
      return applied(`PO ${c.value} set on ${todo.length} line${todo.length === 1 ? "" : "s"}`);
    }

    // sac
    if (c.value !== w.invoice.sac) return refuse(`SAC ${c.value} does not match the invoice's SAC ${w.invoice.sac}`);
    const targets = c.line_id ? [findLine(w, c.line_id)] : w.invoice.lines;
    const todo = targets.filter((l) => l.sac !== c.value);
    if (!todo.length) return noop("SAC is already on every targeted line");
    for (const l of todo) l.sac = c.value;
    return applied(`SAC ${c.value} set on ${todo.length} line${todo.length === 1 ? "" : "s"}`);
  },

  regroup_lines(w) {
    // Sites in the order the buyer lists them; lines keep their relative order within a site.
    const order = (l: InvoiceLine) => w.buyer.sites.findIndex((s) => s.code === l.site_code);
    const before = w.invoice.lines.map((l) => l.line_id).join(",");
    w.invoice.lines = [...w.invoice.lines].sort((a, b) => order(a) - order(b));
    return before === w.invoice.lines.map((l) => l.line_id).join(",")
      ? noop("lines are already grouped by site")
      : applied("lines regrouped by site");
  },

  apply_template(w) {
    const plan: ToolCall[] = [];
    const unresolved: { rule_id: string; line_ids: string[]; reason: string }[] = [];
    const grouping: ToolCall[] = [];

    for (const r of runChecks(checkContext(w), w.rules)) {
      if (r.outcome !== "fail" || r.bucket !== "format") continue;
      const check = w.rules.find((x) => x.rule_id === r.rule_id)?.check;
      if (!check) continue;

      if ((check.kind === "line_field_matches" || check.kind === "line_field_required") && check.field === "po_number") {
        plan.push({ tool: "set_field", field: "po_number", value: w.invoice.po_number });
      } else if ((check.kind === "line_field_matches" || check.kind === "line_field_required") && check.field === "sac") {
        plan.push({ tool: "set_field", field: "sac", value: w.invoice.sac });
      } else if (check.kind === "lines_grouped_by") {
        grouping.push({ tool: "regroup_lines", group_by: "site_code" });
      } else {
        unresolved.push({
          rule_id: r.rule_id, line_ids: [],
          reason: "this is not an edit to the invoice, so it cannot be applied automatically",
        });
      }
    }

    const expand = [...plan, ...grouping];
    if (!expand.length && !unresolved.length) return noop("nothing to apply; the invoice already conforms");
    const message = `${expand.length} format fix${expand.length === 1 ? "" : "es"} planned, ${unresolved.length} left for a person`;
    return { status: expand.length ? "applied" : "noop", message, data: { unresolved }, expand };
  },

  // ---- reads
  recompute_invoice(w) {
    return read(`grand total ${w.invoice.totals.grand_total}`, w.invoice.totals);
  },

  validate_against_spec(w) {
    const results = runChecks(checkContext(w), w.rules);
    const failing = results
      .filter((r) => r.outcome === "fail")
      .map((r) => ({ rule_id: r.rule_id, bucket: r.bucket, message: r.finding!.message }));
    const manual = results.filter((r) => r.outcome === "manual").length;
    const passing = results.filter((r) => r.outcome === "pass").length;
    return read(`${failing.length} failing, ${manual} for a person, ${passing} passing`, { failing, manual, passing });
  },
};

// ----------------------------------------------------------------- dispatch
const summarise = (err: z.ZodError) =>
  err.issues.map((i) => `${i.path.join(".") || "(call)"}: ${i.message}`).join("; ");

function safeClone(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return String(value);
  }
}

function withLog(d: MutableDraft, raw: unknown, tool: string, actor: Actor, status: LogEntry["status"], message: string): void {
  d.log.push({ seq: d.log.length + 1, tool, args: safeClone(raw), actor, status, message, grand_total_after: d.invoice.totals.grand_total });
}

function reject(draft: Draft, raw: unknown, tool: string, actor: Actor, error: string) {
  const next = structuredClone(draft) as MutableDraft;
  withLog(next, raw, tool, actor, "rejected", error);
  return { draft: next as Draft, result: { ok: false, status: "rejected", error } as ToolResult };
}

/**
 * Apply one tool call to a draft. `raw` is whatever the caller has, usually
 * parsed model output, and is validated here. Returns a new draft; the input
 * is never modified. A rejected call returns the draft unchanged except for
 * its log entry.
 */
export function applyToolCall(draft: Draft, raw: unknown, opts: ApplyOptions): { draft: Draft; result: ToolResult } {
  const name = typeof raw === "object" && raw !== null && "tool" in raw ? String((raw as { tool: unknown }).tool) : "(none)";
  if (!(name in TOOL_KIND)) {
    return reject(draft, raw, name, opts.actor, `unknown tool "${name}"; the tools are ${Object.keys(TOOL_KIND).join(", ")}`);
  }

  const parsed = ToolCallSchema.safeParse(raw);
  if (!parsed.success) return reject(draft, raw, name, opts.actor, `invalid call: ${summarise(parsed.error)}`);
  const call = parsed.data;

  if (TOOL_KIND[call.tool] === "business" && opts.actor !== "merchant") {
    return reject(draft, raw, name, opts.actor,
      `approval_required: ${call.tool} changes what the buyer is billed, so only the merchant can apply it`);
  }

  const work = structuredClone(draft) as MutableDraft;
  let outcome: Outcome;
  try {
    outcome = (HANDLERS[call.tool] as (w: MutableDraft, c: ToolCall) => Outcome)(work, call);
  } catch (err) {
    if (err instanceof ToolError) return reject(draft, raw, name, opts.actor, err.message);
    throw err;
  }

  if (outcome.status === "applied") refresh(work);
  withLog(work, raw, name, opts.actor, outcome.status, outcome.message);

  let current = work as Draft;
  let data = outcome.data;
  if (outcome.expand?.length) {
    const steps: { tool: string; status: string; message: string }[] = [];
    for (const step of outcome.expand) {
      const r = applyToolCall(current, step, { actor: "engine" });
      current = r.draft;
      steps.push({ tool: step.tool, status: r.result.status, message: r.result.ok ? r.result.message : r.result.error });
    }
    data = { ...(outcome.data as object), steps };
  }

  return { draft: current, result: { ok: true, status: outcome.status, message: outcome.message, data } };
}

// ------------------------------------------------------------------ preview
/**
 * What a set of business proposals would do to the invoice, in money the
 * arithmetic engine computes. Applies them as the merchant to a throwaway copy;
 * the draft passed in is untouched.
 */
export function previewImpact(draft: Draft, calls: unknown[]): { results: ToolResult[]; delta: TotalsDelta } {
  let current = draft;
  const results: ToolResult[] = [];
  for (const call of calls) {
    const r = applyToolCall(current, call, { actor: "merchant" });
    current = r.draft;
    results.push(r.result);
  }
  return { results, delta: compareInvoices(draft.invoice, current.invoice) };
}
