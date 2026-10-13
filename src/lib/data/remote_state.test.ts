import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLedger, readStateJson, resetState, writeStateJson, writeRunArtifact } from "./load";
import { flush, hydrate, persisted, remoteStateConfigured } from "./remote_state";

/** A stand-in for the Redis REST endpoint: one shared key-value store that every "instance" talks to. */
function fakeRedis() {
  const store = new Map<string, string>();
  const calls: string[][] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const cmd = JSON.parse(init.body) as string[];
    calls.push(cmd);
    if (cmd[0] === "GET") return Response.json({ result: store.get(cmd[1]!) ?? null });
    if (cmd[0] === "SET") {
      store.set(cmd[1]!, cmd[2]!);
      return Response.json({ result: "OK" });
    }
    return Response.json({ error: "unsupported" }, { status: 400 });
  });
  return { store, calls };
}

/** Each instance has its own disk, which is exactly what a serverless host gives you. */
const instance = (dir: string) => {
  process.env.STATE_DIR = dir;
};

let a: string;
let b: string;
beforeEach(() => {
  a = mkdtempSync(join(tmpdir(), "inst-a-"));
  b = mkdtempSync(join(tmpdir(), "inst-b-"));
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "t";
  process.env.LEDGER_RULES = "12";
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["STATE_DIR", "KV_REST_API_URL", "KV_REST_API_TOKEN", "LEDGER_RULES"]) delete process.env[k];
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

describe("shared state across instances", () => {
  it("shows a second instance what the first one saved", async () => {
    fakeRedis();
    instance(a);
    await persisted(async () => writeStateJson("analyses/INV-1.json", { saved_at: "now", result: "the analysis" }));

    instance(b); // another request, another disk
    expect(readStateJson("analyses/INV-1.json", null)).toBeNull(); // the bug: nothing here yet
    await hydrate();
    expect(readStateJson("analyses/INV-1.json", null)).toEqual({ saved_at: "now", result: "the analysis" });
  });

  it("carries a learned rule to the next request, wherever it lands", async () => {
    fakeRedis();
    instance(a);
    await hydrate();
    const before = loadLedger().length;
    await persisted(async () => {
      writeStateJson("app.json", { invoices: { "INV-2": { approved: [] } } });
      // the ledger is seeded on first read and then changed by the commit
      const ledger = loadLedger();
      writeStateJson("rule_ledger.json", [...ledger, { ...ledger[0]!, rule_id: "NEW-1" }]);
    });

    instance(b);
    await hydrate();
    expect(loadLedger()).toHaveLength(before + 1);
    expect(loadLedger().some((r) => r.rule_id === "NEW-1")).toBe(true);
  });

  it("propagates a reset, so a stale instance does not bring the old state back", async () => {
    fakeRedis();
    instance(a);
    await persisted(async () => writeStateJson("analyses/INV-1.json", { stale: true }));
    instance(b);
    await hydrate();
    expect(existsSync(join(b, "analyses", "INV-1.json"))).toBe(true);

    instance(a);
    await persisted(async () => {
      rmSync(join(a, "analyses"), { recursive: true, force: true });
      resetState();
    });
    instance(b);
    await hydrate();
    expect(readStateJson("analyses/INV-1.json", null)).toBeNull();
  });

  it("flushes even when the action redirects (throws)", async () => {
    const { store } = fakeRedis();
    instance(a);
    await expect(
      persisted(async () => {
        writeStateJson("app.json", { invoices: { x: { approved: [] } } });
        throw new Error("NEXT_REDIRECT");
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect([...store.values()].join()).toContain("approved");
  });

  it("keeps per-run debug snapshots out of the shared copy", async () => {
    const { store } = fakeRedis();
    instance(a);
    mkdirSync(a, { recursive: true });
    writeRunArtifact("run-1", "context.json", { big: "x".repeat(1000) });
    await flush();
    const files = Object.keys((JSON.parse([...store.values()][0]!) as { files: object }).files);
    expect(files.some((f) => f.startsWith("runs/"))).toBe(false);
  });

  it("carries on with the local copy when Redis is unreachable on read, but not when a write is lost", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    instance(a);
    writeStateJson("app.json", { invoices: {} });
    await expect(hydrate()).resolves.toBeUndefined();
    expect(readStateJson("app.json", null)).toEqual({ invoices: {} });
    await expect(flush()).rejects.toThrow();
  });
});

describe("without Redis", () => {
  it("does nothing, so local dev and the other tests are unaffected", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    instance(a);
    expect(remoteStateConfigured()).toBe(false);
    await persisted(async () => writeStateJson("app.json", { invoices: {} }));
    await hydrate();
    expect(spy).not.toHaveBeenCalled();
  });
});
