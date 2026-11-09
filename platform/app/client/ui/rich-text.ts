/** Preserve link tokens for rendering and sentence-boundary formatting. */
export function richTextParts(text: string) {
  return String(text).split(/(\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>]+)/g);
}
