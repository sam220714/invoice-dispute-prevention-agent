import { readFixture, writeFixture } from "../data/load";
import { LlmError, requestKey, type GenerateRequest, type GenerateResult, type LlmProvider } from "./provider";

/**
 * Record a real run once, replay it forever. Replay makes the eval free and
 * repeatable, and it is the demo's safety net: a busy API on the day cannot sink
 * a run that was recorded earlier. A recording is only replayed against the exact
 * prompt that produced it. If the prompt or context has changed, replay refuses,
 * because answering an old question with an old answer would prove nothing.
 */

interface RecordedCall {
  key: string;
  model: string;
  text: string;
  usage?: GenerateResult["usage"];
}

interface Fixture {
  version: 1;
  recorded_at: string;
  provider: string;
  calls: RecordedCall[];
}

/** Wraps a real provider and saves every reply it gets. */
export class RecordingProvider implements LlmProvider {
  readonly name: string;
  private readonly calls: RecordedCall[] = [];

  constructor(
    private readonly inner: LlmProvider,
    private readonly fixtureName: string,
  ) {
    this.name = `record(${inner.name})`;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const result = await this.inner.generate(req);
    this.calls.push({ key: requestKey(req), model: result.model, text: result.text, usage: result.usage });
    const fixture: Fixture = {
      version: 1,
      recorded_at: new Date().toISOString(),
      provider: this.inner.name,
      calls: this.calls,
    };
    writeFixture(this.fixtureName, fixture);
    return result;
  }
}

/** Answers from a recording, never from the network. */
export class ReplayProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly fixtureName: string,
    private readonly opts: { allowStale?: boolean } = {},
  ) {
    this.name = `replay(${fixtureName})`;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const fixture = readFixture(this.fixtureName) as Fixture | null;
    if (!fixture) {
      throw new LlmError(`no recording named "${this.fixtureName}"; record one first with --record ${this.fixtureName}`);
    }
    const key = requestKey(req);
    const hit = fixture.calls.find((c) => c.key === key);
    if (hit) return { text: hit.text, model: `${hit.model} (replayed)`, usage: hit.usage, attempts: [] };

    if (this.opts.allowStale && fixture.calls[0]) {
      const c = fixture.calls[0];
      return { text: c.text, model: `${c.model} (replayed, STALE)`, usage: c.usage, attempts: [] };
    }
    throw new LlmError(
      `the recording "${this.fixtureName}" is stale: the prompt or context has changed since it was made ` +
        `(recorded ${fixture.recorded_at}). Re-record it with --record ${this.fixtureName}.`,
    );
  }
}

/** For tests: returns canned replies in order, and remembers what it was asked. */
export class StubProvider implements LlmProvider {
  readonly name = "stub";
  readonly requests: GenerateRequest[] = [];
  private i = 0;

  constructor(private readonly replies: string[]) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = this.replies[Math.min(this.i++, this.replies.length - 1)];
    if (text === undefined) throw new LlmError("StubProvider has no replies");
    return { text, model: "stub", attempts: [] };
  }
}
