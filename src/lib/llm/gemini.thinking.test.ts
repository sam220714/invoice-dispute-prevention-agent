import { afterEach, describe, expect, it } from "vitest";
import { GeminiProvider, geminiFromEnv } from "./gemini";

const req = { system: "s", user: "u", schema: { type: "object" } };
const ok = () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] }), { status: 200 });

async function bodyFor(make: (f: typeof fetch) => GeminiProvider) {
  let body: Record<string, any> = {};
  const f = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return ok();
  }) as unknown as typeof fetch;
  await make(f).generate(req);
  return body;
}

describe("thinking level", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is sent when set", async () => {
    const body = await bodyFor((fetch) => new GeminiProvider({ apiKey: "k", models: ["m"], thinkingLevel: "low", fetch }));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("is left to the model when not set", async () => {
    const body = await bodyFor((fetch) => new GeminiProvider({ apiKey: "k", models: ["m"], fetch }));
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("comes from GEMINI_THINKING", async () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_THINKING = "High";
    const body = await bodyFor((fetch) => geminiFromEnv({ fetch }));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("defaults to low when the environment says nothing, because default thinking was slow and once starved the JSON", async () => {
    process.env.GEMINI_API_KEY = "k";
    delete process.env.GEMINI_THINKING;
    const body = await bodyFor((fetch) => geminiFromEnv({ fetch }));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("rejects a value it does not understand, rather than silently ignoring it", () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_THINKING = "extreme";
    expect(() => geminiFromEnv()).toThrow(/GEMINI_THINKING must be/);
  });
});
