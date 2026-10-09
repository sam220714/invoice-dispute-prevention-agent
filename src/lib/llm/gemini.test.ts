import { afterEach, describe, expect, it } from "vitest";
import { GeminiProvider, geminiFromEnv, toGeminiSchema, type GeminiOptions } from "./gemini";
import { LlmError } from "./provider";

const KEY = "AQ.test-secret-key-123";
const req = { system: "sys", user: "usr", schema: { type: "object", properties: { x: { const: "a" } } } };

const okBody = (text = '{"ok":true}', extra: Record<string, unknown> = {}) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 300 },
  ...extra,
});
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A fake fetch that plays back responses in order and records each call. */
function fake(...script: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script[Math.min(i++, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function make(script: (Response | Error)[], over: Partial<GeminiOptions> = {}) {
  const f = fake(...script);
  const sleeps: number[] = [];
  const provider = new GeminiProvider({
    apiKey: KEY, models: ["primary", "backup"], fetch: f.fetchFn, baseDelayMs: 1000,
    sleep: async (ms) => void sleeps.push(ms), ...over,
  });
  return { provider, calls: f.calls, sleeps };
}

const modelOf = (c: { url: string }) => c.url.split("/models/")[1]!.split(":")[0];

describe("a normal call", () => {
  it("returns the text, the model and token usage", async () => {
    const { provider, calls } = make([reply(200, okBody())]);
    const r = await provider.generate(req);
    expect(r.text).toBe('{"ok":true}');
    expect(r.model).toBe("primary");
    expect(r.usage).toEqual({ input: 100, output: 20, thinking: 300 });
    expect(r.attempts).toEqual([{ model: "primary", status: 200, ms: expect.any(Number) }]);
    expect(calls).toHaveLength(1);
  });

  it("puts the key in a header, never the URL", async () => {
    const { provider, calls } = make([reply(200, okBody())]);
    await provider.generate(req);
    expect(calls[0]!.url).not.toContain(KEY);
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it("asks for JSON against the schema, deterministically", async () => {
    const { provider, calls } = make([reply(200, okBody())]);
    await provider.generate(req);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", temperature: 0 });
    expect(body.generationConfig.responseJsonSchema.properties.x).toEqual({ enum: ["a"] });
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents[0].parts[0].text).toBe("usr");
  });

  it("ignores the model's thinking parts", async () => {
    const body = { candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "hmm" }, { text: '{"a":1}' }] } }] };
    expect((await make([reply(200, body)]).provider.generate(req)).text).toBe('{"a":1}');
  });
});

describe("a busy model", () => {
  it("moves straight to the next model instead of retrying in place", async () => {
    const { provider, calls, sleeps } = make([reply(503), reply(200, okBody())]);
    const r = await provider.generate(req);
    expect(r.model).toBe("backup");
    expect(r.attempts.map((a) => a.status)).toEqual([503, 200]);
    expect(calls.map(modelOf)).toEqual(["primary", "backup"]);
    expect(sleeps).toEqual([]); // no waiting while a healthy model is available
  });

  it("goes back to the primary on the next round, once the whole chain has failed", async () => {
    const { provider, calls, sleeps } = make([reply(503), reply(503), reply(200, okBody())]);
    const r = await provider.generate(req);
    expect(r.model).toBe("primary");
    expect(calls.map(modelOf)).toEqual(["primary", "backup", "primary"]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(1000);
  });

  it("backs off further each round", async () => {
    const { provider, sleeps } = make([reply(503), reply(503), reply(503), reply(503), reply(200, okBody())], { rounds: 3 });
    await provider.generate(req);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("with a single model, retries it with backoff", async () => {
    const { provider, calls, sleeps } = make([reply(503), reply(503), reply(200, okBody())], { models: ["only"] });
    const r = await provider.generate(req);
    expect(r.attempts.map((a) => a.status)).toEqual([503, 503, 200]);
    expect(calls.map(modelOf)).toEqual(["only", "only", "only"]);
    expect(sleeps).toHaveLength(2);
  });

  it("obeys Retry-After on a 429 before the next round", async () => {
    const { provider, sleeps } = make([reply(429, {}, { "retry-after": "3" }), reply(503), reply(200, okBody())]);
    await provider.generate(req);
    expect(sleeps).toEqual([3000]);
  });

  it("treats a network failure and a timeout like a busy model", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const { provider } = make([new TypeError("fetch failed"), timeout, reply(200, okBody())]);
    expect((await provider.generate(req)).attempts.map((a) => a.status)).toEqual(["network", "timeout", 200]);
  });

  it("reports a transient failure when everything stays busy", async () => {
    const { provider } = make([reply(503)], { rounds: 2 });
    const err = await provider.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.transient).toBe(true);
    expect(err.message).toContain("primary 503");
    expect(err.message).toContain("backup 503");
    expect(err.attempts).toHaveLength(4);
  });

  it("gives up at the deadline instead of waiting forever", async () => {
    let t = 0;
    const { provider, calls } = make([reply(503)], { deadlineMs: 10_000, rounds: 10, now: () => (t += 6000) });
    const err = await provider.generate(req).catch((e) => e);
    expect(err.message).toContain("gave up");
    expect(err.transient).toBe(true);
    expect(calls.length).toBeLessThan(6);
  });
});

describe("a request that cannot succeed", () => {
  it("moves to the next model on a 404, and never revisits the missing one", async () => {
    const { provider, calls } = make([reply(404), reply(503), reply(200, okBody())]);
    const r = await provider.generate(req);
    expect(r.model).toBe("backup");
    expect(calls.map(modelOf)).toEqual(["primary", "backup", "backup"]);
  });

  it("stops at once when no model is available to the key", async () => {
    const { provider, calls } = make([reply(404)]);
    const err = await provider.generate(req).catch((e) => e);
    expect(err.message).toContain("every Gemini model failed");
    expect(calls).toHaveLength(2);
  });

  it.each([400, 401, 403])("fails fast on a %i, and does not retry", async (status) => {
    const { provider, calls } = make([reply(status, { error: { message: "bad" } })]);
    const err = await provider.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.transient).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never lets the key into an error, even if the server echoes it", async () => {
    const { provider } = make([reply(400, { error: { message: `invalid key ${KEY}` } })]);
    const err = await provider.generate(req).catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("<key>");
  });
});

describe("a reply that is not usable", () => {
  const withReason = (finishReason: string) => reply(200, { candidates: [{ finishReason, content: { parts: [{ text: "{" }] } }] });

  it("treats a truncated reply as an error, not as a short answer", async () => {
    const err = await make([withReason("MAX_TOKENS")]).provider.generate(req).catch((e) => e);
    expect(err.message).toContain("cut off");
    expect(err.transient).toBe(false);
  });

  it("says when thinking is what ate the output budget", async () => {
    const starved = reply(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }], usageMetadata: { thoughtsTokenCount: 15800 } });
    const err = await make([starved]).provider.generate(req).catch((e) => e);
    expect(err.message).toContain("15800 tokens went on thinking");
    expect(err.message).toContain("GEMINI_THINKING=low");
  });

  it("surfaces a safety stop", async () => {
    const err = await make([withReason("SAFETY")]).provider.generate(req).catch((e) => e);
    expect(err.message).toContain("SAFETY");
  });

  it("surfaces a blocked prompt", async () => {
    const err = await make([reply(200, { promptFeedback: { blockReason: "OTHER" } })]).provider.generate(req).catch((e) => e);
    expect(err.message).toContain("blocked the prompt");
  });

  it("treats an empty reply as transient", async () => {
    const err = await make([reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [] } }] })]).provider.generate(req).catch((e) => e);
    expect(err.message).toContain("empty");
    expect(err.transient).toBe(true);
  });
});

describe("configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses to start without a key, and says where to put it", () => {
    expect(() => new GeminiProvider({ apiKey: "", models: ["m"] })).toThrow(/GEMINI_API_KEY.*\.env\.local/);
  });

  it("reads the key, the model and the fallbacks from the environment", async () => {
    process.env.GEMINI_API_KEY = KEY;
    process.env.GEMINI_MODEL = "m1";
    process.env.GEMINI_FALLBACK_MODELS = "m2, m3,m1";
    const f = fake(reply(503));
    const provider = geminiFromEnv({ fetch: f.fetchFn, sleep: async () => undefined, rounds: 1 });
    await provider.generate(req).catch(() => undefined);
    expect(f.calls.map(modelOf)).toEqual(["m1", "m2", "m3"]); // deduplicated, in order
  });

  it("defaults to a model that is reliably up, then the others", async () => {
    process.env.GEMINI_API_KEY = KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODELS;
    const f = fake(reply(503));
    const provider = geminiFromEnv({ fetch: f.fetchFn, sleep: async () => undefined, rounds: 1 });
    await provider.generate(req).catch(() => undefined);
    expect(f.calls.map(modelOf)).toEqual(["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3-flash-preview"]);
  });
});

describe("toGeminiSchema", () => {
  it("rewrites const to enum and drops bookkeeping keys, recursively", () => {
    expect(toGeminiSchema({ $schema: "x", type: "object", properties: { a: { const: "v" }, b: [{ const: 1 }] }, default: 3 })).toEqual({
      type: "object", properties: { a: { enum: ["v"] }, b: [{ enum: [1] }] },
    });
  });
  it("leaves everything else alone", () => {
    const s = { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 };
    expect(toGeminiSchema(s)).toEqual(s);
  });
});
