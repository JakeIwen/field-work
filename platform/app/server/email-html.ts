/**
 * The HTML version of an email, rendered from the plain text the user edits.
 * Mail apps show HTML at the window width and keep its line breaks, while
 * each lays out plain text its own way: Gmail's web view narrows long lines
 * and Outlook for Windows can join lines it guesses were wrapped. Every
 * newline becomes <br>, so a blank line stays a paragraph break, and no font
 * is set, so each app uses its usual one.
 */

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => entities[char]);

/** Runs of spaces HTML would collapse become non-breaking, keeping one breakable space per run. */
const keepSpaces = (html: string) =>
  html
    .replace(/\t/g, "    ")
    .replace(/ {2,}/g, (run) => `${"&nbsp;".repeat(run.length - 1)} `);

/** Sentence punctuation after a URL is not part of it; a closing bracket is when the URL opened one. */
function trimUrl(url: string) {
  for (;;) {
    const last = url.at(-1)!;
    const unbalanced =
      (last === ")" && url.split("(").length < url.split(")").length) ||
      (last === "]" && url.split("[").length < url.split("]").length);
    if (!unbalanced && !/[.,;:!?'"’”]/.test(last)) return url;
    url = url.slice(0, -1);
  }
}

function lineHtml(line: string) {
  let html = "";
  let at = 0;
  for (const match of line.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = trimUrl(match[0]);
    if (!/^https?:\/\/[^/?#]/.test(url)) continue;
    html += keepSpaces(escapeHtml(line.slice(at, match.index)));
    html += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    at = match.index + url.length;
  }
  html += keepSpaces(escapeHtml(line.slice(at)));
  return html.replace(/^ /, "&nbsp;");
}

export function plainTextHtml(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return `<div dir="ltr">${lines.map(lineHtml).join("<br>\r\n")}</div>`;
}
