import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findBuyer,
  latestInvoiceFor,
  getBuyer,
  getInvoice,
  loadAnnexure,
  loadBuyers,
  loadDemoDispute,
  loadDisputes,
  loadInvoices,
  loadLedger,
  loadRulePool,
  loadSplit,
  resetLedger,
  resolveDatasetPath,
  saveLedger,
} from "./load";
import { CONTEXT_RULES, DEMO_SEED, splitLedger } from "./split";

// The answer-key guard is tested in eval/guards.test.ts: src/ never names that directory.

describe("path guard", () => {
  it("refuses paths that escape dataset/", () => {
    expect(() => resolveDatasetPath("../package.json")).toThrow(/outside dataset/);
    expect(() => resolveDatasetPath("../../etc/passwd")).toThrow(/outside dataset/);
  });

  it("allows ordinary runtime files", () => {
    expect(() => resolveDatasetPath("invoices.json")).not.toThrow();
    expect(() => resolveDatasetPath("annexure_INV-2026-0863.json")).not.toThrow();
  });
});

describe("dataset loaders", () => {
  it("load and validate every runtime file", () => {
    expect(loadBuyers()).toHaveLength(3);
    expect(loadInvoices()).toHaveLength(5);
    expect(loadDisputes()).toHaveLength(15);
    expect(loadDemoDispute()).toContain("OT claimed is 186 hours");
  });

  it("look up by id and fail loudly on a bad id", () => {
    expect(getBuyer("BUY-MERIDIAN").service_charge_base).toBe("wages_only");
    expect(getInvoice("INV-2026-0847").status).toBe("disputed");
    expect(() => getInvoice("INV-NOPE")).toThrow(/unknown invoice/);
    expect(() => getBuyer("BUY-NOPE")).toThrow(/unknown buyer/);
  });

  it("returns the annexure when one exists and null when it does not", () => {
    expect(loadAnnexure("INV-2026-0863")!.rows).toHaveLength(8);
    expect(loadAnnexure("INV-2026-0849")).toBeNull();
  });
});

describe("which invoice a dispute is about when nobody says", () => {
  it("is the buyer's latest invoice that has gone out, never a draft", () => {
    expect(latestInvoiceFor("BUY-MERIDIAN").invoice_id).toBe("INV-2026-0847"); // 0863 is a draft
    expect(latestInvoiceFor("BUY-YOGITA").invoice_id).toBe("INV-2026-0849");
    expect(latestInvoiceFor("BUY-TEAMLEASE").invoice_id).toBe("INV-2026-0852");
  });

  it("fails loudly for a buyer with no invoices", () => {
    expect(() => latestInvoiceFor("BUY-NOPE")).toThrow(/no invoices/);
  });

  it("finds a buyer by id or by name, any case, and refuses a guess", () => {
    expect(findBuyer("yogita").id).toBe("BUY-YOGITA");
    expect(findBuyer("BUY-TEAMLEASE").id).toBe("BUY-TEAMLEASE");
    expect(findBuyer("Meridian Logistics").id).toBe("BUY-MERIDIAN");
    expect(() => findBuyer("acme")).toThrow(/unknown buyer/);
  });
});

describe("rule ledger persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-"));
    process.env.STATE_DIR = dir;
    process.env.LEDGER_RULES = "12";
  });
  afterEach(() => {
    delete process.env.STATE_DIR;
    delete process.env.LEDGER_RULES;
    rmSync(dir, { recursive: true, force: true });
  });

  it("the pool holds 15 business and format rules, each with a check attached", () => {
    const pool = loadRulePool();
    expect(pool).toHaveLength(15);
    expect(pool.every((r) => r.check)).toBe(true);
    expect(new Set(pool.map((r) => r.type))).toEqual(new Set(["business", "format"]));
  });

  it("bootstraps the live ledger from the context half of the split on first load", () => {
    expect(loadLedger()).toEqual(loadSplit(DEMO_SEED).context);
    expect(loadLedger()).toHaveLength(CONTEXT_RULES);
  });

  it("starts from every rule in the pool when LEDGER_RULES is not set", () => {
    delete process.env.LEDGER_RULES;
    expect(loadLedger()).toEqual(loadRulePool());
    expect(loadLedger()).toHaveLength(15);
  });

  it("LEDGER_SEED chooses a different split", () => {
    process.env.LEDGER_SEED = "5";
    try {
      expect(loadLedger()).toEqual(loadSplit(5).context);
    } finally {
      delete process.env.LEDGER_SEED;
    }
  });

  it("persists changes between loads, and reset returns to the split", () => {
    const ledger = loadLedger();
    const target = ledger[0]!.rule_id;
    saveLedger(ledger.map((r) => (r.rule_id === target ? { ...r, status: "disabled" as const } : r)));
    expect(loadLedger().find((r) => r.rule_id === target)!.status).toBe("disabled");
    resetLedger();
    expect(loadLedger().find((r) => r.rule_id === target)!.status).toBe("active");
  });

  it("never writes to the pool", () => {
    const before = JSON.stringify(loadRulePool());
    saveLedger([]);
    expect(JSON.stringify(loadRulePool())).toBe(before);
  });
});

describe("seeded split of the rule pool", () => {
  const pool = loadRulePool();
  const ids = (rules: { rule_id: string }[]) => rules.map((r) => r.rule_id).sort();

  it("puts exactly 12 rules into context and holds the rest out", () => {
    const s = splitLedger(pool, 7);
    expect(s.context).toHaveLength(12);
    expect(s.heldOut).toHaveLength(pool.length - 12);
  });

  it("is a partition: no rule is lost or counted twice", () => {
    const s = splitLedger(pool, 99);
    expect(ids([...s.context, ...s.heldOut])).toEqual(ids(pool));
    expect(new Set(ids(s.context)).size).toBe(s.context.length);
  });

  it("is repeatable: the same seed always gives the same split", () => {
    expect(ids(splitLedger(pool, 123).context)).toEqual(ids(splitLedger(pool, 123).context));
  });

  it("does not depend on the order the pool is stored in", () => {
    expect(ids(splitLedger([...pool].reverse(), 123).context)).toEqual(ids(splitLedger(pool, 123).context));
  });

  it("varies with the seed", () => {
    const splits = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => ids(splitLedger(pool, seed).heldOut).join()));
    expect(splits.size).toBeGreaterThan(3);
  });

  it("the demo seed holds out the two Meridian rules the demo dispute teaches", () => {
    const held = ids(splitLedger(pool, DEMO_SEED).heldOut);
    expect(held).toEqual(["MER-R5", "MER-R6", "YOG-R6"]);
  });

  it("--hold forces named rules out, whatever the seed, and the seed chooses the rest", () => {
    for (const seed of [1, 7, 42, 273]) {
      const s = splitLedger(pool, seed, ["MER-R3", "MER-R5"]);
      expect(ids(s.heldOut)).toEqual(expect.arrayContaining(["MER-R5", "MER-R3"]));
      expect(s.context).toHaveLength(12);
      expect(ids([...s.context, ...s.heldOut])).toEqual(ids(pool));
    }
    expect(ids(splitLedger(pool, 7, ["MER-R3"]).heldOut)).toEqual(ids(splitLedger(pool, 7, ["MER-R3"]).heldOut));
  });

  it("holding more than the spare rules shrinks the context instead of failing", () => {
    const s = splitLedger(pool, 3, ["MER-R1", "MER-R5", "MER-R2", "MER-R6", "MER-R3"]);
    expect(s.context).toHaveLength(10);
    expect(s.heldOut).toHaveLength(5);
  });

  it("--hold refuses a rule that does not exist", () => {
    expect(() => splitLedger(pool, 1, ["MER-R99"])).toThrow(/not in the rule pool/);
  });

  it("refuses a non-integer seed", () => {
    expect(() => splitLedger(pool, 1.5)).toThrow(/integer/);
  });
});
