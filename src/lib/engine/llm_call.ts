import { zodToJsonSchema } from "zod-to-json-schema";
import { AnalysisSchema, verifyQuotes, type Analysis, type RuleProposal } from "./analysis_schema";
import type { AgentContext } from "./context";
import type { Attempt, LlmProvider } from "../llm/provider";

/**
 * The one LLM call. It sends the assembled context, validates what comes back,
 * and gives the model a single chance to fix its own mistakes. Validation covers
 * more than shape: quotes must appear in the message, and every line id and rule
 * id must be one the model was actually shown.
 */

export function analysisJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(AnalysisSchema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
    readonly raw: string,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

export interface AnalysisMeta {
  model: string;
  repaired: boolean;
  attempts: Attempt[];
  usage: { input: number; output: number; thinking: number };
}


/**
 * A rule the model infers is enforced by a plain linter, so a sloppy check is
 * worse than none. These are the deterministic tests a proposed check must pass
 * against the evidence in front of the model.
 */
export function proposalProblems(rule: RuleProposal, _ctx: AgentContext): string[] {
  const problems: string[] = [];
  const check = rule.check;

  if ("pattern" in check) {
    try {
      new RegExp(check.pattern);
    } catch {
      return [`the pattern "${check.pattern}" is not a valid regular expression`];
    }
    if (!check.pattern.startsWith("^") || !check.pattern.endsWith("$"))
      problems.push(`the pattern "${check.pattern}" must be anchored with ^ and $`);
  }

  if (check.kind === "invoice_date_window" && !(check.from_day >= 1 && check.from_day <= check.to_day && check.to_day <= 31))
    problems.push(`the window ${check.from_day}-${check.to_day} is not a valid range of days in a month`);
  if (check.kind === "billing_period_cycle" && ![check.start_day, check.end_day].every((d) => d >= 1 && d <= 31))
    problems.push("the billing cycle days must be between 1 and 31");
  if (check.kind === "payment_terms_days" && !(check.days >= 0 && check.days <= 180))
    problems.push(`${check.days} days is not a plausible payment term`);

  return problems;
}

export type ParseOutcome = { ok: true; analysis: Analysis } | { ok: false; problems: string[] };

/** Tolerates a reply wrapped in a code fence, which some models add despite being told not to. */
function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1]! : text).trim();
}

export function parseAnalysis(text: string, ctx: AgentContext): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch (err) {
    return { ok: false, problems: [`the reply is not valid JSON: ${(err as Error).message}`] };
  }

  const parsed = AnalysisSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const analysis = parsed.data;
  const problems: string[] = [];

  for (const q of verifyQuotes(analysis, ctx.snapshot.message))
    problems.push(`${q.where}: the quote is not an exact span of the buyer's message: "${q.quote}"`);

  const lineIds = new Set(ctx.snapshot.payload.invoice.lines.map((l) => l.line_id));
  const ruleIds = new Set(ctx.snapshot.payload.active_rules.map((r) => r.rule_id));
  for (const c of analysis.claims) {
    for (const id of c.line_ids)
      if (!lineIds.has(id)) problems.push(`${c.claim_id}: line_id "${id}" is not on this invoice`);
    for (const call of c.proposed_calls) {
      const ids = "line_id" in call && call.line_id ? [call.line_id] : "disputed_line_ids" in call ? call.disputed_line_ids : [];
      for (const id of ids)
        if (!lineIds.has(id)) problems.push(`${c.claim_id}: ${call.tool} names line "${id}", which is not on this invoice`);
    }
    if (c.matched_rule_id !== null && !ruleIds.has(c.matched_rule_id))
      problems.push(`${c.claim_id}: matched_rule_id "${c.matched_rule_id}" is not an active rule for this buyer`);
    // The id and the reasoning must agree. A rationale that names some other rule and never the matched
    // one means the id was slipped in wrong, and a wrong match tells the merchant a falsehood.
    if (c.matched_rule_id !== null) {
      const named = [...new Set(c.match_rationale.match(/\b[A-Z]{3}-R\d+\b/g) ?? [])];
      if (named.length && !named.includes(c.matched_rule_id))
        problems.push(
          `${c.claim_id}: matched_rule_id is "${c.matched_rule_id}" but match_rationale talks about ${named.join(", ")}; make them agree`,
        );
    }
  }
  for (const [i, r] of analysis.new_rules.entries())
    for (const p of proposalProblems(r, ctx)) problems.push(`new_rules[${i}]: ${p}`);

  return problems.length ? { ok: false, problems } : { ok: true, analysis };
}

export async function runAnalysis(
  ctx: AgentContext,
  provider: LlmProvider,
): Promise<{ analysis: Analysis; meta: AnalysisMeta }> {
  const schema = analysisJsonSchema();
  const usage = { input: 0, output: 0, thinking: 0 };
  const attempts: Attempt[] = [];
  const tally = (r: Awaited<ReturnType<LlmProvider["generate"]>>) => {
    attempts.push(...r.attempts);
    if (r.usage) {
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      usage.thinking += r.usage.thinking;
    }
  };

  const first = await provider.generate({ system: ctx.system, user: ctx.user, schema });
  tally(first);
  const outcome = parseAnalysis(first.text, ctx);
  if (outcome.ok) return { analysis: outcome.analysis, meta: { model: first.model, repaired: false, attempts, usage } };

  const repairPrompt =
    `${ctx.user}\n\n` +
    `Your previous reply was rejected by the validator.\n<previous_reply>\n${first.text}\n</previous_reply>\n` +
    `Problems:\n${outcome.problems.map((p) => `- ${p}`).join("\n")}\n\n` +
    `Return a corrected JSON object that fixes every problem. Change nothing else.`;

  const second = await provider.generate({ system: ctx.system, user: repairPrompt, schema });
  tally(second);
  const retry = parseAnalysis(second.text, ctx);
  if (retry.ok) return { analysis: retry.analysis, meta: { model: second.model, repaired: true, attempts, usage } };

  throw new AnalysisError(
    `the model's reply was still invalid after one repair attempt (${retry.problems.length} problem${retry.problems.length === 1 ? "" : "s"})`,
    retry.problems,
    second.text,
  );
}
