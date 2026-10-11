/** Display helpers. Money is formatted here, never computed: every figure arrives from the invoice engine. */

const INR = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 2448552.84 -> "24,48,552.84" */
export const inr = (n: number) => INR.format(n);

/** 2448552.84 -> "₹24,48,552.84" */
export const rupees = (n: number) => `₹${inr(n)}`;

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const WORDS = ["none", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** 4 -> "four"; past ten stays a numeral. */
export const word = (n: number) => WORDS[n] ?? String(n);
export const Word = (n: number) => {
  const w = word(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-06" -> "6 Oct" (and "6 Oct 2026" when asked). */
export function shortDate(iso: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const out = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  return withYear ? `${out} ${m[1]}` : out;
}

/** ["L1","L2","L3","L9"] -> "L1-L3, L9" */
export function compactLines(ids: string[]): string {
  const nums = ids.map((id) => ({ id, n: Number(id.replace(/\D/g, "")) }));
  if (nums.some((x) => Number.isNaN(x.n))) return ids.join(", ");
  nums.sort((a, b) => a.n - b.n);
  const out: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1]!.n === nums[j]!.n + 1) j++;
    out.push(j > i ? `${nums[i]!.id}-${nums[j]!.id}` : nums[i]!.id);
    i = j + 1;
  }
  return out.join(", ");
}

/** The first word of a person's name: "Prashant Dubey" -> "Prashant". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
