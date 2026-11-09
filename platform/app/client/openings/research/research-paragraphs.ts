import { richTextParts } from "../../ui/rich-text";
import { openingAssessmentValues } from "../../../shared/opening-assessments";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
// The segmenter breaks after "U.S." or "e.g." before a capital; rejoin those.
const abbreviation = /(?:\b(?:[A-Z]\.){2,}|\b(?:e\.g|i\.e|vs|approx|Inc|Jr|Sr|St|Dr|Mr|Ms)\.)$/;
const listMarker = /^\s*(?:[-*•]|\d+[.)])\s+/;
const ratingLabel = new RegExp(`^(?:${openingAssessmentValues.join("|")})[.:]?$`, "i");

function blocks(text: string) {
  return text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).filter(block => block.trim());
}

/** Sentences of one block, never split inside a Markdown link or URL. */
function sentenceSegments(block: string) {
  let offset = 0;
  const links = richTextParts(block).flatMap((part, index) => {
    const start = offset; offset += part.length;
    return index % 2 ? [{ start, end: offset }] : [];
  });
  const segments: string[] = [];
  let pending = "";
  for (const sentence of sentences.segment(block)) {
    pending += sentence.segment;
    const boundary = sentence.index + sentence.segment.length;
    // A real sentence end is followed by whitespace; "or .NET" is not one.
    if (boundary < block.length && !/\s$/.test(sentence.segment)) continue;
    if (links.some(link => boundary > link.start && boundary < link.end)) continue;
    segments.push(pending); pending = "";
  }
  if (pending) segments.push(pending);
  return segments;
}

/** Add presentation breaks without changing wording or breaking links/lists. */
export function researchParagraphs(text: string) {
  return blocks(text).flatMap(block => {
    if (block.length < 420 || block.includes("\n")) return [block];
    const paragraphs: string[] = [];
    let pending = "", count = 0;
    for (const sentence of sentenceSegments(block)) {
      pending += sentence; count++;
      if (pending.length >= 300 || count >= 3) {
        paragraphs.push(pending.trim()); pending = ""; count = 0;
      }
    }
    if (pending.trim()) paragraphs.push(pending.trim());
    return paragraphs;
  });
}

/** One bullet per sentence or list item, grouped by the source's paragraphs
 * (blank-line or single-line breaks; list items stay with the line before). A
 * leading bare rating ("Medium.") followed by more text is dropped because the
 * rating grid shows it. */
export function researchBullets(text: string) {
  const groups: string[][] = [];
  for (const block of blocks(text)) {
    let group: string[] = [];
    for (const line of block.split("\n").filter(line => line.trim())) {
      if (listMarker.test(line)) { group.push(line.replace(listMarker, "").trim()); continue; }
      if (group.length) groups.push(group);
      group = [];
      for (const sentence of sentenceSegments(line.trim())) {
        const last = group.length - 1;
        if (last >= 0 && abbreviation.test(group[last])) group[last] = `${group[last]} ${sentence.trim()}`;
        else group.push(sentence.trim());
      }
    }
    if (group.length) groups.push(group);
  }
  if (ratingLabel.test(groups[0]?.[0] ?? "") && groups.flat().length > 1) groups[0].shift();
  return groups.filter(group => group.length);
}
