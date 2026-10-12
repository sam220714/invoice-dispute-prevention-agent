/**
 * HARNESS, NOT RUNTIME. Proves the answer key never reaches the model.
 *
 * verify.py already scans the runtime data files. This goes one step further and
 * scans the thing that is actually sent: the real system prompt plus the real
 * assembled context, built through the same code path the app uses. If a
 * held-out rule, or a line of the expected analysis, shows up there, the demo
 * proves nothing, because the agent would be reciting rather than inferring.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDemoDispute, loadLedger, loadRulePool, loadSplit, readMessageFile } from "../src/lib/data/load";
import { CONTEXT_RULES, DEMO_SEED } from "../src/lib/data/split";
import { buildContext } from "../src/lib/engine/context";
import { analysisJsonSchema } from "../src/lib/engine/llm_call";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const qa = (name: string) => JSON.parse(readFileSync(join(root, "dataset", "qa", name), "utf-8"));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const expected = qa("expected_analysis.json") as {
  demo_held_out_rules: string[];
  claims: { claim: string; proposed_fix: string; matches_existing_rule: string | null }[];
  new_rules_to_learn: { rule: string }[];
  note_on_split: string;
  commentary: string;
};

/** Everything the model is sent: the prompt, the context, the response schema. */
function sentFor(seed: number): string {
  const ctx = buildContext("BUY-MERIDIAN", "INV-2026-0847", loadDemoDispute(), {
    receivedOn: "2026-10-06",
    rules: loadSplit(seed).context,
  });
  return norm(ctx.system + "\n" + ctx.user + "\n" + JSON.stringify(analysisJsonSchema()));
}

/** The text of a held-out rule must not appear, whole or as a run of six words. */
function expectAbsent(sent: string, rule: string) {
  expect(sent).not.toContain(norm(rule).slice(0, 60));
  const words = norm(rule).split(" ");
  for (let i = 0; i + 6 <= words.length; i++) {
    expect(sent, `six consecutive words from ${rule}`).not.toContain(words.slice(i, i + 6).join(" "));
  }
}

describe("the prompt the model actually receives, on the demo seed", () => {
  const split = loadSplit(DEMO_SEED);
  const sent = sentFor(DEMO_SEED);

  it("exists to be tested: three rules are held out", () => {
    expect(split.heldOut.map((r) => r.rule_id).sort()).toEqual([...expected.demo_held_out_rules].sort());
    expect(split.context).toHaveLength(CONTEXT_RULES);
  });

  it.each(split.heldOut.map((r) => [r.rule_id, r.rule] as const))("does not contain held-out rule %s", (_id, rule) => {
    expectAbsent(sent, rule);
  });

  it("does not contain the expected answers", () => {
    for (const c of expected.claims) {
      expect(sent).not.toContain(norm(c.proposed_fix));
      // "MER-R3 (DSP-004) - OT requires ..." : the id is ordinary provenance in the ledger; the prose is the answer.
      const prose = c.matches_existing_rule?.split(/\s[—-]\s/)[1];
      if (prose) expect(sent).not.toContain(norm(prose));
    }
    for (const r of expected.new_rules_to_learn) expect(sent).not.toContain(norm(r.rule));
    expect(sent).not.toContain(norm(expected.commentary).slice(0, 60));
    expect(sent).not.toContain(norm(expected.note_on_split).slice(0, 60));
  });

  it("does not contain the answer-key file names or fields", () => {
    for (const needle of ["ground_truth", "expected_analysis", "expected_rules", "recoverable_from", "rule_learned", "demo_held_out"]) {
      expect(sent, needle).not.toContain(needle);
    }
  });

  it("does contain the rules that are in context, so the check above is not passing vacuously", () => {
    for (const r of split.context.filter((x) => x.rule_id.startsWith("MER-"))) {
      expect(sent, r.rule_id).toContain(norm(r.rule));
    }
  });

  it("works from the live ledger too, which is what the app passes", () => {
    const live = buildContext("BUY-MERIDIAN", "INV-2026-0847", loadDemoDispute(), { receivedOn: "2026-10-06", rules: loadLedger() });
    const text = norm(live.system + live.user);
    for (const r of loadRulePool().filter((x) => !loadLedger().some((l) => l.rule_id === x.rule_id))) {
      expect(text).not.toContain(norm(r.rule).slice(0, 60));
    }
  });
});

describe("whatever the seed, a held-out rule never reaches the model", () => {
  // The pool holds 15 rules and 12 go into context, so a held-out rule's text is
  // in the dataset but must stay out of the prompt for every split.
  it.each([0, 1, 2, 7, 42, 273, 1000, 98765])("seed %i", (seed) => {
    const split = loadSplit(seed);
    expect(split.context).toHaveLength(CONTEXT_RULES);
    expect(split.heldOut.length).toBe(loadRulePool().length - CONTEXT_RULES);
    const sent = sentFor(seed);
    // Only Meridian's rules are in a Meridian prompt; other buyers' rules never appear either way.
    for (const r of split.heldOut) expectAbsent(sent, r.rule);
  });
});

describe("reading a message from disk", () => {
  it.each([
    "dataset/qa/expected_analysis.json",
    "dataset\\qa\\expected_analysis.json",
    "dataset\\QA\\verify.py",
    "./dataset/qa/../qa/ground_truth_rules.json",
  ])("refuses %s", (path) => {
    expect(() => readMessageFile(path)).toThrow(/answer key/);
  });

  it("reads the demo message", () => {
    expect(readMessageFile("dataset/demo_dispute.txt")).toContain("OT claimed is 186 hours");
  });
});
