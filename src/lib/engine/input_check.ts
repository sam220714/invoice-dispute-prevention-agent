/**
 * Is what was pasted worth sending to the model? Plain code, run before any model call.
 *
 * Only three things are refused, because none of them can be a message: nothing at all, a fragment
 * too short to hold a claim, and far too much. Anything else goes to the model, which says whether the
 * text holds a claim. (An earlier version also guessed whether an email "looked cut off". The guess
 * was unreliable, so it was removed rather than tuned.)
 */

export const MIN_CHARS = 12;
export const MAX_CHARS = 20_000;
const TAIL_CHARS = 70;

export type InputVerdict =
  | { status: "ok"; tail: string }
  | { status: "blocked"; reason: "no_text" | "too_short" | "too_long"; message: string };

export type NotReady = Exclude<InputVerdict, { status: "ok" }>;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The last words of the message, for the "what the agent looked at" panel. */
export function tailOf(text: string, n = TAIL_CHARS): string {
  const flat = collapse(text);
  return flat.length > n ? `…${flat.slice(flat.length - n).trimStart()}` : flat;
}

export function checkMessage(raw: string): InputVerdict {
  const text = raw.replace(/\r\n?/g, "\n").trim();

  if (!/\p{L}/u.test(text))
    return { status: "blocked", reason: "no_text", message: "There is nothing to analyse yet. Paste the buyer's message first." };
  if (text.length < MIN_CHARS)
    return {
      status: "blocked", reason: "too_short",
      message: `That is only ${text.length} characters. Paste the whole message the buyer sent, not a fragment.`,
    };
  if (text.length > MAX_CHARS)
    return {
      status: "blocked", reason: "too_long",
      message: `That is ${text.length.toLocaleString("en-IN")} characters, over the ${MAX_CHARS.toLocaleString("en-IN")} limit. Paste only the buyer's message, without the earlier thread.`,
    };

  return { status: "ok", tail: tailOf(text) };
}
