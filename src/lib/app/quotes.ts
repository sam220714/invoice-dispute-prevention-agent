/**
 * Where in the buyer's message each claim's quote sits, so selecting a claim can light its words.
 *
 * The engine already guarantees every quote appears in the message (verifyQuotes ignores case and
 * whitespace), so the match here is the same loose one. Spans may overlap, because a rule is often
 * taught by the very words a claim quotes; the message is cut at every boundary and each piece
 * remembers which keys it belongs to.
 */

export interface Span {
  key: string;
  quote: string;
}

export interface Segment {
  text: string;
  /** Keys of every claim or rule whose quote covers this piece. Empty for plain text. */
  keys: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** [start, end) of the quote in the message, ignoring case and runs of whitespace. Null when absent. */
export function locate(message: string, quote: string): [number, number] | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const m = new RegExp(words.map(escapeRe).join("\\s+"), "i").exec(message);
  return m ? [m.index, m.index + m[0].length] : null;
}

export function segmentMessage(message: string, spans: Span[]): Segment[] {
  const found = spans
    .map((s) => ({ key: s.key, at: locate(message, s.quote) }))
    .filter((s): s is { key: string; at: [number, number] } => s.at !== null);
  if (!found.length) return [{ text: message, keys: [] }];

  const cuts = [...new Set([0, message.length, ...found.flatMap((f) => f.at)])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i]!, cuts[i + 1]!];
    if (from === to) continue;
    out.push({
      text: message.slice(from, to),
      keys: found.filter((f) => f.at[0] <= from && f.at[1] >= to).map((f) => f.key),
    });
  }
  return out;
}
