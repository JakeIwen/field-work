const maxNeedlePatternLength = 65536;
const regexLiteral = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Only an odd run of backslashes introduces a JSON escape. A script's literal
// \\u text is not an encoded identity in the enclosing stored JSON value.
const escapedIdentity = String.raw`(?<!\\)(?:\\\\)*\\(?:u|/)`;
const escapedExpression = new RegExp(escapedIdentity);
export const hasEscapedDeletionJson = (json: string) =>
  escapedExpression.test(json);

/** References are whole keys/values, not identity text quoted inside a transcript.
 * Noncanonical Unicode/slash escapes still take the conservative decoding path. */
export function deletionReferenceScreen(needles: string[]) {
  const pattern = [
    ...new Set(
      needles
        .filter(Boolean)
        .map((needle) => regexLiteral(JSON.stringify(needle))),
    ),
    escapedIdentity,
  ].join("|");
  if (pattern.length > maxNeedlePatternLength) return () => true;
  const expression = new RegExp(pattern);
  return (json: string) => expression.test(json);
}
