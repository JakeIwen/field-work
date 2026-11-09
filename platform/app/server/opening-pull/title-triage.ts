import { termPattern, compileFitCriteria } from "../fit-criteria.js";
import type { FitCriteria } from "../../shared/fit-criteria.js";

const softwareEngineeringTitleTerms = [
  "engineer",
  "engineering",
  "engenharia",
  "engenheiro",
  "ingeniero",
  "ingenieria",
  "ingenieur",
  "developer",
  "development",
  "desenvolvedor",
  "desenvolvimento",
  "desarrollador",
  "entwickler",
  "developpeur",
  "programmer",
  "programming",
  "software",
  "swe",
  "sde",
  "architect",
  "full stack",
  "back end",
  "front end",
  "dev ops",
  "sre",
  "site reliability",
  "web",
  "mobile",
  "ios",
  "android",
  "platform",
  "tech lead",
  "technical lead",
  "cto",
  "chief technology",
  "coder",
];
const titleRoleMatchers = softwareEngineeringTitleTerms.map((term) => ({
  term,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${termPattern(term)})(?![\\p{L}\\p{N}_])`,
    "u",
  ),
}));

export function pullTitleExclusion(
  title: string,
  criteria?: FitCriteria,
  titleTriage = true,
): string | undefined {
  if (criteria && compileFitCriteria(criteria).titleExclude?.test(title)) {
    const term = criteria.titleExcludeTerms.find((term) =>
      compileFitCriteria({
        ...criteria,
        titleExcludeTerms: [term],
      }).titleExclude?.test(title),
    );
    if (term)
      return `Title triage: “${title}” matches your excluded title term “${term}”.`;
  }
  if (!titleTriage) return undefined;
  const normalized = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  // A PM title names the managed platform, not an engineering role; other role terms still pass.
  const platformProductManager = /^pm\b/u.test(normalized);
  if (
    titleRoleMatchers.some(
      ({ term, pattern }) =>
        !(term === "platform" && platformProductManager) &&
        pattern.test(normalized),
    )
  )
    return undefined;
  return `Title triage: “${title}” is not a software engineering or development title.`;
}
