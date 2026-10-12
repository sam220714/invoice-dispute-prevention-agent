import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Server actions call revalidatePath, which only exists inside a Next request.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));

import { resetState } from "../lib/data/load";
import { DEMO_SEED } from "../lib/data/split";
import { loadRecord, resetApp } from "../lib/app/store";
import { setFormatFix } from "./actions";

describe("switching a format fix off for one invoice", () => {
  let dir: string;
  const saved = { state: process.env.STATE_DIR, seed: process.env.LEDGER_SEED };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "format-fix-"));
    process.env.STATE_DIR = dir;
    process.env.LEDGER_SEED = String(DEMO_SEED);
    process.env.LEDGER_RULES = "12";
  });
  afterAll(() => {
    process.env.STATE_DIR = saved.state;
    if (saved.seed === undefined) delete process.env.LEDGER_SEED;
    else process.env.LEDGER_SEED = saved.seed;
    delete process.env.LEDGER_RULES;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetState();
    resetApp();
  });

  it("turns a fix off and back on, on the invoice's own record", async () => {
    expect(await setFormatFix("INV-2026-0863", "MER-R1", false)).toEqual({ ok: true });
    expect(loadRecord("INV-2026-0863").format_off).toEqual(["MER-R1"]);
    expect(await setFormatFix("INV-2026-0863", "MER-R1", false)).toEqual({ ok: true });
    expect(loadRecord("INV-2026-0863").format_off).toEqual(["MER-R1"]);
    expect(await setFormatFix("INV-2026-0863", "MER-R1", true)).toEqual({ ok: true });
    expect(loadRecord("INV-2026-0863").format_off).toEqual([]);
  });

  it("refuses a business rule, a rule that does not exist, and an invoice that has gone out", async () => {
    expect((await setFormatFix("INV-2026-0863", "MER-R3", false)).ok).toBe(false);
    expect((await setFormatFix("INV-2026-0863", "MER-R99", false)).ok).toBe(false);
    expect((await setFormatFix("INV-2026-0847", "MER-R1", false)).ok).toBe(false);
    expect(loadRecord("INV-2026-0863").format_off ?? []).toEqual([]);
  });

  it("is kept per invoice", async () => {
    await setFormatFix("INV-2026-0863", "MER-R2", false);
    expect(loadRecord("INV-2026-0847").format_off ?? []).toEqual([]);
  });
});
