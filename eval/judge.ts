/**
 * HARNESS, NOT RUNTIME. The verdict logic for the classifier eval, kept apart
 * from the live calls so it can be tested without a model.
 *
 * Only "this absolutely breaks the product" is a failure. Anything softer is
 * reported by the runner and never changes the exit code.
 */
import type { Analysis, RuleProposal } from "../src/lib/engine/analysis_schema";
import type { Check } from "../src/lib/schema";

/** Key order must not matter: two checks are the same rule when kind and parameters agree. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sameCheck = (a: Check, b: Check) => canonical(a) === canonical(b);

export interface Verdict {
  pass: boolean;
  /** Why it failed, or a one-line note on why it passed. */
  reason: string;
}

/**
 * A rule is in the ledger and the dispute is the one that taught it. Some claim
 * in the reply must be matched to that rule: the merchant is told the defect
 * was foreseeable, which is the whole point.
 */
export function judgeExisting(analysis: Analysis, expectedRule: string): Verdict {
  const matched = analysis.claims.filter((c) => c.matched_rule_id).map((c) => `${c.claim_id}->${c.matched_rule_id}`);
  if (analysis.claims.some((c) => c.matched_rule_id === expectedRule))
    return { pass: true, reason: `matched ${expectedRule}` };
  return {
    pass: false,
    reason: matched.length
      ? `no claim was matched to ${expectedRule} (matched: ${matched.join(", ")})`
      : `no claim was matched to ${expectedRule} (nothing was matched at all)`,
  };
}

export interface NewRuleVerdict extends Verdict {
  /** Claims matched to a rule the dispute has nothing to do with. */
  wrongMatches: string[];
  /** The proposed rule whose check equals the held-out rule's, if any. */
  found: RuleProposal | null;
}

/**
 * The rule is held out and the dispute is the one that taught it. Two ways to
 * break: the agent says an unrelated existing rule already covers the defect
 * (which hides the new rule and tells the merchant a falsehood), or it fails to
 * propose a rule whose check is the held-out rule's.
 *
 * `allowedMatches` are the in-context rules this same dispute also teaches (the
 * SAC rule, in the dispute that teaches both SAC and the window). Matching those
 * is correct, not wrong.
 */
export function judgeNewRule(
  analysis: Analysis,
  opts: { expectedCheck: Check; allowedMatches: ReadonlySet<string> },
): NewRuleVerdict {
  const wrongMatches = analysis.claims
    .filter((c) => c.matched_rule_id && !opts.allowedMatches.has(c.matched_rule_id))
    .map((c) => `${c.claim_id}->${c.matched_rule_id}`);
  const found = analysis.new_rules.find((r) => sameCheck(r.check, opts.expectedCheck)) ?? null;

  if (wrongMatches.length)
    return { pass: false, wrongMatches, found, reason: `matched an unrelated existing rule (${wrongMatches.join(", ")}), which hides the new one` };
  if (!found)
    return {
      pass: false, wrongMatches, found,
      reason: analysis.new_rules.length
        ? `proposed ${analysis.new_rules.length} rule(s), none with the expected check (${canonical(opts.expectedCheck)})`
        : "proposed no rule at all",
    };
  return { pass: true, wrongMatches, found, reason: "proposed a rule with the expected check" };
}
