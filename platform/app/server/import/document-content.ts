import { load } from "cheerio";

import { isoDate } from "./parse-companies.js";

export function htmlText(html: string): string {
  const $ = load(html);
  $("script,style,noscript,template,iframe,object,embed").remove();
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,section,tr,header,footer").each(
    (_, element) => {
      $(element).append("\n");
    },
  );
  return $("body")
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Only a revision/authorship declaration is a document date. Employment dates and mtime are not. */
export function authoredDate(text: string): string | null {
  const declaration = text.match(
    /^(?:[#*\s-]*)(?:Reviewed|Prepared|Updated|Revised|Authored|Created|Written|Date)\s*:?\s*(?:(\d{4}-\d{2}-\d{2})|([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4}))/im,
  );
  if (!declaration) return null;
  if (declaration[1]) return isoDate(declaration[1]);
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = months.indexOf(declaration[2].toLowerCase());
  if (month < 0) return null;
  return isoDate(
    `${declaration[4]}-${String(month + 1).padStart(2, "0")}-${declaration[3].padStart(2, "0")}`,
  );
}

export function letterDate(text: string): string | null {
  // A dateline near the top of an actual letter is explicit date evidence.
  const dateline = text
    .split("\n")
    .slice(0, 18)
    .find((line) =>
      /^\s*(?:[A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})\s*$/.test(line),
    );
  return dateline ? authoredDate(`Date: ${dateline.trim()}`) : null;
}

// Superseded resume versions and rejected/legacy archives are expected to lack
// authored dates and privacy markers; they stay importable but are left out of
// the informational import findings. `version` is the current master
// directory declared by the source README (null when it cannot be established).
export function isLegacyResumeDocument(
  relative: string,
  version: string | null,
) {
  const parts = relative.split("/");
  if (parts[0] === "old_resume") return true;
  if (parts.slice(0, -1).some((dir) => /_bad/i.test(dir))) return true;
  return (
    parts[0] === "source_master_template" &&
    parts.length > 2 &&
    !!version &&
    parts[1] !== version
  );
}

export function currentVersion(readme: string): string | null {
  return (
    readme.match(
      /current general content master[^\n]*?source_master_template\/(v\d+[^/`\s]*)\//i,
    )?.[1] ?? null
  );
}

/** Tailored folders are current only when explicitly named alongside the general master. */
export function currentTailoredDirectories(readme: string): string[] {
  return [
    ...readme.matchAll(
      /current tailored (?:content )?master[^\n]*?`(employer_specific\/[^`]+\/)`/gi,
    ),
  ]
    .map((match) => match[1].replace(/\/$/, ""))
    .filter(
      (directory) =>
        /^employer_specific\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(
          directory,
        ) && !directory.includes("/revisions"),
    );
}

/** Explicit README privacy declarations replace owner-specific filename exceptions. */
export function privateDocumentPaths(
  readme: string,
  directory: string,
): string[] {
  return readme
    .split(/\r?\n/)
    .filter((line) => /^Private files:\s*/i.test(line))
    .flatMap((line) => [...line.matchAll(/`([A-Za-z0-9_-][A-Za-z0-9_.-]*)`/g)])
    .map((match) => `${directory}/${match[1]}`);
}
