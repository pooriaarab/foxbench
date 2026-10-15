// Masks secrets in text, for a redacted benchmark that keeps a log. A secret
// matches whatever its case, spacing or punctuation, and so does each of its
// long words: a log that quotes one word of a gold answer still gives it away.
const MASK = "[masked]";
const LETTERS = "\\p{L}\\p{N}";
const words = (s: string) => s.match(new RegExp(`[${LETTERS}]+`, "gu")) ?? [];
const pattern = (parts: string[]) =>
  new RegExp(`(?<![${LETTERS}])${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(`[^${LETTERS}]*`)}(?![${LETTERS}])`, "giu");

/** The patterns for one secret: the whole of it, and each word of four characters or more. */
export function secretPatterns(secret: string): RegExp[] {
  const all = words(secret);
  if (!all.length) return [];
  return [pattern(all), ...all.filter((w) => w.length >= 4).map((w) => pattern([w]))];
}

/** The patterns for a passage: the whole of it, and each clause of four words or more. */
export function passagePatterns(passage: string): RegExp[] {
  const clauses = passage.split(/[.?!;:,\n]/).filter((c) => words(c).length >= 4);
  return [...secretPatterns(passage).slice(0, 1), ...clauses.map((c) => pattern(words(c)))];
}

/** Replaces every match, longest pattern source first. */
export function mask(text: string, patterns: RegExp[]): string {
  return patterns.toSorted((a, b) => b.source.length - a.source.length).reduce((t, re) => t.replace(re, MASK), text);
}
