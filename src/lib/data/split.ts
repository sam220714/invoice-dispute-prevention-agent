import type { Rule } from "../schema";

/**
 * The rule ledger is a pool. A seed splits it in two: CONTEXT_RULES rules go into
 * the agent's context, and the rest are held out as the things it has yet to
 * learn. The same seed always gives the same split, so a test run is repeatable,
 * and a different seed gives a different but equally repeatable one.
 *
 * Held-out rules never reach a prompt. They exist so a person (or a test) can
 * check whether the agent infers them from a dispute.
 */

/** How many rules go into the agent's context. */
export const CONTEXT_RULES = 12;

/**
 * The seed the demo runs on. It holds out MER-R5 (site-wise grouping), MER-R6
 * (the 1st-5th portal window) and YOG-R6, so the demo dispute teaches two new
 * Meridian rules. A test asserts this still holds.
 */
export const DEMO_SEED = 469;

/** mulberry32: a tiny seeded generator. Math.random() cannot be seeded. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LedgerSplit {
  seed: number;
  /** Goes into the agent's context. Ordered as in the pool. */
  context: Rule[];
  /** Held out for testing. Never shown to the model. */
  heldOut: Rule[];
}

/**
 * `hold` names rules that must be held out whatever the seed says, for testing one
 * rule at a time. The seed then chooses the rest. If so many are held that fewer
 * than `contextSize` rules remain, the context is simply smaller.
 */
export function splitLedger(pool: Rule[], seed: number, hold: string[] = [], contextSize = CONTEXT_RULES): LedgerSplit {
  if (!Number.isInteger(seed)) throw new Error(`the seed must be an integer, got ${seed}`);
  if (contextSize < 0 || contextSize > pool.length)
    throw new Error(`cannot put ${contextSize} of ${pool.length} rules into context`);
  const known = new Set(pool.map((r) => r.rule_id));
  const unknown = hold.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`cannot hold out ${unknown.join(", ")}: not in the rule pool (${[...known].sort().join(", ")})`);
  const forced = new Set(hold);

  // Shuffle the ids, not the rules: a stable base order (by id) makes the split depend on the seed alone.
  const ids = pool.map((r) => r.rule_id).filter((id) => !forced.has(id)).sort();
  const next = mulberry32(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  const inContext = new Set(ids.slice(0, Math.min(contextSize, ids.length)));
  return {
    seed,
    context: pool.filter((r) => inContext.has(r.rule_id)),
    heldOut: pool.filter((r) => !inContext.has(r.rule_id)),
  };
}
