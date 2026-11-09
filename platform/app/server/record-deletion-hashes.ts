import { hasEscapedDeletionJson } from "./record-deletion-json.js";

/** A regex match can retain the entire transcript backing its substring. Copy
 * each 64-byte hash before a preview caches it beyond the streaming scan. */
export const deletionHashes = (value: unknown): string[] =>
  typeof value === "string"
    ? (value.match(/\b[a-f0-9]{64}\b/g) ?? []).map((hash) =>
        Buffer.from(hash, "ascii").toString("ascii"),
      )
    : Array.isArray(value)
      ? value.flatMap(deletionHashes)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(deletionHashes)
        : [];

const maxHashPatternLength = 65536;

/** Look only for selected objects still missing a retaining owner. Raw matches
 * are decoded before accepting them: keys are not values, and escapes can hide hashes. */
export function deletionHashRetention(hashes: Set<string>) {
  const pending = new Set(hashes),
    retained = new Set<string>();
  let size = -1,
    expression: RegExp,
    afterControl: RegExp,
    broad = false;
  const retain = (json: string, value: () => unknown) => {
    if (!pending.size) return;
    if (size !== pending.size) {
      size = pending.size;
      const alternatives = [...pending].join("|");
      broad = alternatives.length > maxHashPatternLength;
      // Named control escapes end with a word character in raw JSON, but the
      // decoded newline/tab/etc. is a hash boundary. Accept either spelling.
      const content = broad ? "[a-f0-9]{64}" : `(?:${alternatives})`;
      expression = new RegExp(`\\b${content}\\b`, broad ? "g" : "");
      afterControl = new RegExp(`\\\\[bfnrt]${content}\\b`, broad ? "g" : "");
    }
    const matchesPattern = (pattern: RegExp) =>
      broad
        ? (json.match(pattern) ?? []).some((match) =>
            pending.has(match.slice(-64)),
          )
        : pattern.test(json);
    const matches =
      hasEscapedDeletionJson(json) ||
      matchesPattern(expression) ||
      matchesPattern(afterControl);
    if (!matches) return;
    for (const hash of deletionHashes(value()))
      if (pending.delete(hash)) retained.add(hash);
  };
  return { retained, retain };
}
