import { LlmError, type Attempt, type GenerateRequest, type GenerateResult, type LlmProvider } from "./provider";

/**
 * Gemini over REST. The free tier is the point of friction: the newest models
 * answer 503 or hang for minutes at a time while older siblings answer in two
 * seconds. So a busy model is not retried in place. The call moves straight to
 * the next model in the chain, and only backs off once a whole round has failed.
 * Failing fast on a bad key or a bad schema matters just as much as persisting
 * through a busy one.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export interface GeminiOptions {
  apiKey: string;
  /** Tried in order each round. The first is the primary; the rest are fallbacks. */
  models: string[];
  /** Passes over the whole chain before giving up. */
  rounds?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per request. */
  timeoutMs?: number;
  /** Whole call, every round included. */
  deadlineMs?: number;
  maxOutputTokens?: number;
  /** How hard the model thinks before answering. Unset leaves the model's own default. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Gemini accepts a subset of JSON Schema. Rewrite what it rejects: `const` becomes
 * a one-value `enum`, and the bookkeeping keys it does not know are dropped. The
 * engine validates the reply with zod either way, so this only guides the model.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "$schema" || key === "$id" || key === "default") continue;
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly o: Required<Omit<GeminiOptions, "apiKey" | "models" | "thinkingLevel">> &
    Pick<GeminiOptions, "apiKey" | "models" | "thinkingLevel">;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) throw new LlmError("GEMINI_API_KEY is not set. Put it in .env.local (see .env.example).");
    if (!options.models.length) throw new LlmError("no Gemini model is configured; set GEMINI_MODEL");
    this.o = {
      rounds: 3,
      baseDelayMs: 2000,
      maxDelayMs: 12_000,
      timeoutMs: 45_000,
      deadlineMs: 240_000,
      maxOutputTokens: 32_000,
      fetch: globalThis.fetch.bind(globalThis),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...options,
    };
  }

  /** Never let the key reach an error message, a log line or a fixture. */
  private redact(text: string): string {
    return text.split(this.o.apiKey).join("<key>");
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const attempts: Attempt[] = [];
    const started = this.o.now();
    const unavailable = new Set<string>(); // models this key cannot use at all
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiSchema(req.schema),
        temperature: 0,
        maxOutputTokens: this.o.maxOutputTokens,
        ...(this.o.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.o.thinkingLevel } } : {}),
      },
    });

    for (let round = 1; round <= this.o.rounds; round++) {
      let waitHintMs = 0;

      for (const model of this.o.models) {
        if (unavailable.has(model)) continue;
        if (this.o.now() - started > this.o.deadlineMs) {
          throw new LlmError(`gave up after ${Math.round(this.o.deadlineMs / 1000)}s: ${this.summary(attempts)}`, attempts, true);
        }

        const t0 = this.o.now();
        let response: Response | undefined;
        let failure: Attempt["status"] | undefined;
        try {
          response = await this.o.fetch(`${ENDPOINT}/${model}:generateContent`, {
            method: "POST",
            headers: { "x-goog-api-key": this.o.apiKey, "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(this.o.timeoutMs),
          });
        } catch (err) {
          failure = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError" ? "timeout" : "network";
        }

        attempts.push({ model, status: failure ?? response!.status, ms: this.o.now() - t0 });

        if (response?.ok) return this.parse(await response.json(), model, attempts);

        if (failure || RETRYABLE.has(response!.status)) {
          waitHintMs = Math.max(waitHintMs, this.retryAfterMs(response));
          continue; // a busy model: try the next one straight away
        }

        const detail = this.redact(await response!.text().catch(() => ""));
        // 404: this model is not available to this key. Another one might be.
        if (response!.status === 404) {
          unavailable.add(model);
          continue;
        }
        // 400, 401, 403: the request or the key is wrong. Retrying cannot help.
        throw new LlmError(`Gemini rejected the request (${response!.status}) on ${model}: ${detail.slice(0, 300)}`, attempts, false);
      }

      if (unavailable.size === this.o.models.length) break;
      if (round < this.o.rounds) await this.o.sleep(Math.max(waitHintMs, this.backoff(round)));
    }
    throw new LlmError(`every Gemini model failed: ${this.summary(attempts)}`, attempts, true);
  }

  private retryAfterMs(response?: Response): number {
    const seconds = Number(response?.headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, this.o.maxDelayMs) : 0;
  }

  private backoff(round: number): number {
    const exponential = Math.min(this.o.baseDelayMs * 2 ** (round - 1), this.o.maxDelayMs);
    return exponential + Math.random() * 500; // jitter, so parallel callers do not retry in step
  }

  private summary(attempts: Attempt[]): string {
    return attempts.map((a) => `${a.model} ${a.status}`).join(", ");
  }

  private parse(json: unknown, model: string, attempts: Attempt[]): GenerateResult {
    const j = json as {
      candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    if (j.promptFeedback?.blockReason)
      throw new LlmError(`Gemini blocked the prompt: ${j.promptFeedback.blockReason}`, attempts, false);

    const candidate = j.candidates?.[0];
    const reason = candidate?.finishReason;
    if (reason === "MAX_TOKENS") {
      // Gemini counts its thinking against the output limit, so heavy thinking can starve the JSON.
      const spent = j.usageMetadata?.thoughtsTokenCount;
      throw new LlmError(
        `the reply was cut off at the output limit, so the JSON is incomplete` +
          (spent ? ` (${spent} tokens went on thinking; try GEMINI_THINKING=low)` : ""),
        attempts,
        false,
      );
    }
    if (reason && reason !== "STOP")
      throw new LlmError(`Gemini stopped with ${reason}`, attempts, false);

    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!text.trim()) throw new LlmError("Gemini returned an empty reply", attempts, true);

    const u = j.usageMetadata;
    return {
      text,
      model,
      attempts,
      usage: u
        ? { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0 }
        : undefined,
    };
  }
}

/**
 * The chain tried each round: the primary from GEMINI_MODEL, then fallbacks.
 * Probed 2026-10-09 on the free tier: 3.6, 3.5 and 3-flash-preview answered in
 * 1-3 seconds while 3.8 returned 503 after as long as 68 seconds and 3.7 hung.
 * Newest is not fastest, so the default leads with a model that is reliably up
 * and keeps 3.8 as a fallback; set GEMINI_MODEL=gemini-3.8-flash to lead with it.
 * Pro models are left out: they need billing.
 */
export const DEFAULT_MODEL = "gemini-3.6-flash";
export const DEFAULT_FALLBACKS = "gemini-3.5-flash,gemini-3.8-flash,gemini-3-flash-preview";
/** Enough for this task: extraction and short arithmetic. Deeper thinking cost 35-113s and once starved the JSON. */
export const DEFAULT_THINKING = "low";

export function geminiFromEnv(overrides: Partial<GeminiOptions> = {}): GeminiProvider {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? DEFAULT_FALLBACKS)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const models = [...new Set([primary, ...fallbacks])];
  const level = (process.env.GEMINI_THINKING?.trim() || DEFAULT_THINKING).toLowerCase();
  const thinkingLevel = (["minimal", "low", "medium", "high"] as const).find((l) => l === level);
  if (!thinkingLevel) throw new LlmError(`GEMINI_THINKING must be minimal, low, medium or high, not "${level}"`);
  return new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", models, thinkingLevel, ...overrides });
}
