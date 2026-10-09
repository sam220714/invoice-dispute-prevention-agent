import { createHash } from "node:crypto";

/**
 * The seam between the engine and whichever model answers. The engine hands over
 * a prompt and a JSON Schema; it gets text back. Swapping Gemini for Claude is a
 * new file implementing this, not a change to the engine.
 */

export interface GenerateRequest {
  system: string;
  user: string;
  /** Standard JSON Schema for the response. Provider-specific quirks are the provider's problem. */
  schema: Record<string, unknown>;
}

export interface Attempt {
  model: string;
  /** HTTP status, or why there was none. */
  status: number | "network" | "timeout";
  ms: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage?: { input: number; output: number; thinking: number };
  attempts: Attempt[];
}

export interface LlmProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[] = [],
    /** True when trying again later might succeed (capacity), false when it cannot (bad key, bad schema). */
    readonly transient = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Identifies a request, so a recorded response is only replayed against the prompt that produced it. */
export function requestKey(req: GenerateRequest): string {
  return createHash("sha256")
    .update(req.system)
    .update("\0")
    .update(req.user)
    .update("\0")
    .update(JSON.stringify(req.schema))
    .digest("hex")
    .slice(0, 16);
}
