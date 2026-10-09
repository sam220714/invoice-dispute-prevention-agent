import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmError, requestKey, type GenerateRequest } from "./provider";
import { RecordingProvider, ReplayProvider, StubProvider } from "./replay";

const req = (user = "question"): GenerateRequest => ({ system: "sys", user, schema: { type: "object" } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fixtures-"));
  process.env.FIXTURES_DIR = dir;
});
afterEach(() => {
  delete process.env.FIXTURES_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("requestKey", () => {
  it("is stable, and changes with any part of the request", () => {
    expect(requestKey(req())).toBe(requestKey(req()));
    expect(requestKey(req())).not.toBe(requestKey(req("other")));
    expect(requestKey(req())).not.toBe(requestKey({ ...req(), system: "different" }));
    expect(requestKey(req())).not.toBe(requestKey({ ...req(), schema: { type: "array" } }));
  });
});

describe("record then replay", () => {
  it("replays exactly what was recorded, offline", async () => {
    const live = new StubProvider(['{"answer":42}']);
    const recorded = await new RecordingProvider(live, "run").generate(req());
    expect(recorded.text).toBe('{"answer":42}');

    const replayed = await new ReplayProvider("run").generate(req());
    expect(replayed.text).toBe('{"answer":42}');
    expect(replayed.model).toContain("replayed");
    expect(replayed.attempts).toEqual([]);
    expect(live.requests).toHaveLength(1); // replay made no second call
  });

  it("keeps every call of a run, so a repair attempt replays too", async () => {
    const recorder = new RecordingProvider(new StubProvider(["first", "second"]), "run");
    await recorder.generate(req("a"));
    await recorder.generate(req("b"));
    const replay = new ReplayProvider("run");
    expect((await replay.generate(req("a"))).text).toBe("first");
    expect((await replay.generate(req("b"))).text).toBe("second");
  });

  it("starts a fresh recording rather than appending to an old one", async () => {
    await new RecordingProvider(new StubProvider(["old"]), "run").generate(req("a"));
    await new RecordingProvider(new StubProvider(["new"]), "run").generate(req("b"));
    await expect(new ReplayProvider("run").generate(req("a"))).rejects.toThrow(/stale/);
  });
});

describe("a stale recording", () => {
  beforeEach(async () => {
    await new RecordingProvider(new StubProvider(["old answer"]), "run").generate(req("old question"));
  });

  it("is refused: an old answer to an old question proves nothing", async () => {
    const err = await new ReplayProvider("run").generate(req("a changed question")).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("stale");
    expect(err.message).toContain("--record run");
  });

  it("can be replayed anyway when explicitly allowed, and is marked as stale", async () => {
    const r = await new ReplayProvider("run", { allowStale: true }).generate(req("a changed question"));
    expect(r.text).toBe("old answer");
    expect(r.model).toContain("STALE");
  });
});

describe("a missing recording", () => {
  it("says how to make one", async () => {
    const err = await new ReplayProvider("nothing-here").generate(req()).catch((e) => e);
    expect(err.message).toContain("no recording named");
    expect(err.message).toContain("--record nothing-here");
  });

  it("only accepts plain names, so a recording cannot point elsewhere", async () => {
    await expect(new ReplayProvider("../../etc/passwd").generate(req())).rejects.toThrow(/bad fixture name/);
  });
});

describe("StubProvider", () => {
  it("returns replies in order, repeats the last, and remembers requests", async () => {
    const stub = new StubProvider(["a", "b"]);
    expect([(await stub.generate(req())).text, (await stub.generate(req())).text, (await stub.generate(req())).text]).toEqual(["a", "b", "b"]);
    expect(stub.requests).toHaveLength(3);
  });
});
