/**
 * Is what was pasted ready to analyse? Plain code, run before any model call.
 *
 * Two kinds of answer:
 *   blocked        Nothing to analyse, or far too much. The person must change the text.
 *   maybe_cut_off  The text looks like the top of an email, not the whole of it. Soft: the person
 *                  can add the rest, or analyse anyway. The model is not called until they choose.
 *
 * Nothing here is remembered. If the message is cut off, the person appends the rest in the same
 * box and submits again, and the whole message is analysed from scratch.
 *
 * Some cuts cannot be seen: an email that stops cleanly after a full sentence looks complete. The
 * best signal for that is an opening greeting with no sign-off, and for the rest the person sees
 * the last words the agent read (`tail`) and can judge for themselves.
 */

export const MIN_CHARS = 12;
export const MAX_CHARS = 20_000;
const TAIL_CHARS = 70;

export type InputVerdict =
  | { status: "ok"; tail: string }
  | { status: "blocked"; reason: "no_text" | "too_short" | "too_long"; message: string }
  | { status: "maybe_cut_off"; signals: string[]; message: string; tail: string };

export type NotReady = Exclude<InputVerdict, { status: "ok" }>;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The last words of the message, for showing the person where the agent stopped reading. */
export function tailOf(text: string, n = TAIL_CHARS): string {
  const flat = collapse(text);
  return flat.length > n ? `…${flat.slice(flat.length - n).trimStart()}` : flat;
}

const HEADER_LINE = /^(from|to|cc|bcc|date|sent|subject)\s*:/i;
const GREETING = /^(dear\b|hi\b|hello\b|respected\b|namaste\b|good (morning|afternoon|evening)\b|(sir|madam|ma'am|sir\s*\/\s*madam|madam\s*\/\s*sir)\s*[,.:]?$)/i;
const SIGNOFF =
  /^(thanks|thank you|many thanks|regards|best regards|warm regards|kind regards|with regards|thanks and regards|thanks\s*&\s*regards|sincerely|yours (faithfully|sincerely|truly)|cheers)[\s,.!-]*$/i;
/** "... Please revise. Regards, Prashant" on one line: a sign-off followed by a name. */
const INLINE_SIGNOFF = /\b(regards|thanks|thank you|sincerely)[,.!]?\s+[A-Z][\w.'’-]*(\s+[A-Z][\w.'’-]*){0,3}$/i;
const SENTENCE_END = /[.!?)\]"'”’]$/;
const SMALL_WORD = /^(of|and|&|-|–|\|)$/i;

/** A name, a title or a company line: a few words, each capitalised ("Lakshmi", "Manager - Accounts"). */
function looksLikeSignature(line: string): boolean {
  const words = line.trim().split(/\s+/);
  if (words.length > 6 || /^\d/.test(words[0]!)) return false;
  return words.every((w) => SMALL_WORD.test(w) || /^[A-Z0-9(][\w.&'’()/,-]*$/.test(w));
}

/**
 * A signature closes an email, so it follows a finished sentence, a sign-off, or another signature line.
 * A capitalised fragment on the line after a half-finished one ("... OT and the", then "Sham") is the
 * text being cut, not a name.
 * And a lone name is not a message: there has to be something above it.
 */
function isSignature(line: string, prev: string | undefined): boolean {
  if (!looksLikeSignature(line) || prev === undefined || GREETING.test(prev)) return false;
  return SENTENCE_END.test(prev) || SIGNOFF.test(prev) || looksLikeSignature(prev);
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

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

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !HEADER_LINE.test(l));
  const first = body[0] ?? "";
  const last = body[body.length - 1] ?? lines[lines.length - 1]!;
  const prev = body[body.length - 2];
  const signals: string[] = [];

  // How the message ends.
  if (/(\.\.\.|…)$/.test(last)) {
    signals.push("it ends with an ellipsis");
  } else if (/^(\d+[.)]|[-•*])$/.test(last)) {
    signals.push(`it ends on a list marker ("${last}") with nothing after it`);
  } else if (GREETING.test(last) && last === first) {
    signals.push(`it is only a greeting ("${last.replace(/[,:]+$/, "")}")`);
  } else if (SIGNOFF.test(last)) {
    signals.push(`it ends on "${last.replace(/[\s,.!-]+$/, "")}" with no name after it`);
  } else if (SENTENCE_END.test(last) || INLINE_SIGNOFF.test(last) || isSignature(last, prev)) {
    // A full stop, a closing bracket, or a name or title: it ends where an email ends.
  } else if (/\d$/.test(last) && body.length <= 2) {
    // A short note that ends on an amount or a count.
  } else if (lines.length === 1 && last.split(/\s+/).length < 8) {
    // A single short line ("lol what's up") is a whole message, not the top of an email. It is not a cut-off
    // worth stopping for: the model will say whether it holds any claim.
  } else {
    signals.push(`it ends in the middle of a sentence, on "${last.split(/\s+/).slice(-4).join(" ")}"`);
  }

  // Cut in the middle of a bracket.
  if (count(text, "(") > count(text, ")")) signals.push("a bracket is opened and never closed");

  // The top of an email, without its end.
  if (body.length > 1 && GREETING.test(first) && !SIGNOFF.test(last) && !isSignature(last, prev) && signals.length === 0)
    signals.push(`it opens with a greeting ("${first.replace(/[,:]+$/, "")}") but has no sign-off`);

  const tail = tailOf(text);
  if (!signals.length) return { status: "ok", tail };
  return {
    status: "maybe_cut_off",
    signals,
    tail,
    message: `This looks cut off: ${signals.join("; ")}. Add the rest of the message below and analyse again, or analyse what is here.`,
  };
}
