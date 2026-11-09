import { tunables } from "../shared/tunables.js";
import type {
  DocumentOverflow,
  OverflowLayout,
} from "../shared/application-preparation.js";

// The resume renderer prints this line before its overflow error. Without it, a
// shortening turn knows only the overflow in points and can trim words that never
// remove a wrapped line, leaving the page exactly as long as before.
const reportLine = /^Layout report: (\{.*\})$/m;
const maxBlocks = 80;
const maxText = 200;
const quotedText = 70;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, max: number) =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= max;

/** A stored or parsed layout with every field in bounds; anything else is dropped. */
export function overflowLayout(value: unknown): OverflowLayout | undefined {
  if (!isRecord(value)) return;
  const { lineHeight, blocks } = value;
  if (
    typeof lineHeight !== "number" ||
    !(lineHeight > 0 && lineHeight <= 100) ||
    !Array.isArray(blocks) ||
    blocks.length > maxBlocks
  )
    return;
  const valid: OverflowLayout["blocks"] = [];
  for (const block of blocks) {
    if (
      !isRecord(block) ||
      typeof block.text !== "string" ||
      !count(block.lines, 200) ||
      (block.lines as number) < 1 ||
      !count(block.lastLineChars, 1000)
    )
      return;
    valid.push({
      text: block.text.replace(/\s+/g, " ").trim().slice(0, maxText),
      lines: block.lines as number,
      lastLineChars: block.lastLineChars as number,
    });
  }
  return { lineHeight, blocks: valid };
}

/** Reads the trusted renderer's report for the page that overflowed. */
export function parseOverflowLayout(stderr: string, page: number) {
  const match = reportLine.exec(stderr);
  if (!match) return;
  try {
    const report: unknown = JSON.parse(match[1]);
    return isRecord(report) && report.page === page
      ? overflowLayout(report)
      : undefined;
  } catch {
    return;
  }
}

/** Overflow amounts arrive as raw floats such as 1.120000000000232. */
export const overflowPoints = (points: number) => Number(points.toFixed(2));

function quote(text: string) {
  if (text.length <= quotedText) return text;
  const cut = text.slice(0, quotedText);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : quotedText)}…`;
}

/** Tells a shortening turn which cuts can actually shorten the page. */
export function overflowLayoutGuidance(
  overflow: DocumentOverflow,
  shownBlocks: number = tunables["autofill.overflowTargets"].default,
) {
  const layout = overflowLayout(overflow.layout);
  if (!layout) return "";
  const needed = Math.ceil(overflow.points / layout.lineHeight);
  const shortest = layout.blocks
    .filter((block) => block.lines > 1)
    .sort((a, b) => a.lastLineChars - b.lastLineChars)
    .slice(0, shownBlocks);
  const lines = [
    `Measured layout of page ${overflow.page}: each body line is ${overflowPoints(layout.lineHeight)} points, so removing ${needed} full ${needed === 1 ? "line" : "lines"} clears the overflow. A cut shortens the page only when it removes a block's last wrapped line; trimming words from a block that keeps its line count saves nothing. Only page ${overflow.page} blocks count, because the page break is fixed.`,
  ];
  if (shortest.length)
    lines.push(
      `Page ${overflow.page} blocks with the shortest last lines. Cutting at least that many characters, plus a word for safety, from one of them removes its last line:`,
      ...shortest.map(
        (block) =>
          `- "${quote(block.text)}": ${block.lines} lines, last line ${block.lastLineChars} characters`,
      ),
    );
  return lines.join("\n");
}
