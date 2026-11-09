import type { AnswersOnlyAutofillCount } from "../../shared/application-preparation";
import type { Opening } from "../../shared/types";
import { openingSkillMatch, skillMatchOrder, type SkillMatch } from "./skills/opening-skill-match";
import { openingAssessmentValuesFor, type OpeningAssessmentValue } from "../../shared/opening-assessments";

export const openingSortOptions = [
  ["docs-first", "Generated docs first"],
  ["autofill-ready", "Autofill · fewest to finish first"],
  ["technical-high", "Technical fit · High first"],
  ["technical-low", "Technical fit · Low first"],
  ["remote-high", "Remote fit · High first"],
  ["remote-low", "Remote fit · Low first"],
  ["wlb-high", "WLB outlook · High first"],
  ["wlb-low", "WLB outlook · Low first"],
  ["company", "Company · A–Z"],
  ["company-desc", "Company · Z–A"],
  ["newest", "Added · newest first"],
  ["oldest", "Added · oldest first"],
  ["posted-newest", "Posted · newest first"],
  ["posted-oldest", "Posted · oldest first"],
  ["skills-percent", "Skills · % match first"],
  ["skills-count", "Skills · # matched first"],
] as const;
export type OpeningSort = typeof openingSortOptions[number][0];
export function openingSort(value: unknown): OpeningSort {
  return openingSortOptions.find(([key]) => key === value)?.[0] ?? "docs-first";
}
// The old key was written automatically, so it cannot establish an explicit choice.
export const openingSortStorageKey = "fieldwork.openings.sort.v2";
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function timestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
export function openingPostedDate(o: Opening): string | null {
  // Publication is independent of import, scan and employer update timestamps.
  return timestamp(o.first_published) === null ? null : String(o.first_published);
}
export function openingAddedDate(o: Opening): { value: string | null; provenance: string; approximate: boolean } {
  for (const [field, provenance] of [["createdAt", "Created in Fieldwork"], ["firstImportedAt", "First imported into Fieldwork"]]) {
    if (timestamp(o[field]) !== null) return { value: String(o[field]), provenance, approximate: false };
  }
  if (timestamp(o.first_seen) !== null) return { value: o.first_seen, provenance: "First seen; exact date added was not recorded", approximate: true };
  return { value: null, provenance: "Date added unknown", approximate: false };
}
function dateOrder(a: number | null, b: number | null, newest = false) {
  // Missing dates stay at the bottom in either direction.
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return newest ? b - a : a - b;
}
function finishOrder(a: number | undefined, b: number | undefined) {
  // Openings without a ready script follow every Opening that has one.
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return a - b;
}
function assessmentOrder(a: OpeningAssessmentValue, b: OpeningAssessmentValue, lowFirst = false) {
  const ranks = { High: 0, Medium: 1, Low: 2, Uncertain: 3, Unknown: 4 };
  const x = ranks[a], y = ranks[b];
  // Unresolved assessments remain last in both directions.
  if (x >= 3 || y >= 3) return x >= 3 && y >= 3 ? x - y : x >= 3 ? 1 : -1;
  return lowFirst ? y - x : x - y;
}
export function sortOpenings(openings: Opening[], value: unknown, generationCounts: Record<string, number> = {}, autofillFinishCounts: Record<string, number> = {}, knownSkills: readonly string[] = [], answerCounts: Record<string, AnswersOnlyAutofillCount> = {}): Opening[] {
  const mode = openingSort(value);
  const docsFirst = (a: Opening, b: Opening) => Number((generationCounts[b.id] ?? 0) > 0) - Number((generationCounts[a.id] ?? 0) > 0);
  const added = (o: Opening) => timestamp(openingAddedDate(o).value);
  const known = new Set(knownSkills);
  const matches = new Map<Opening, SkillMatch>();
  const match = (opening: Opening) => {
    let result = matches.get(opening);
    if (!result) { result = openingSkillMatch(opening, known); matches.set(opening, result); }
    return result;
  };
  const comparators: Record<OpeningSort, (a: Opening, b: Opening) => number> = {
    "docs-first": docsFirst,
    "autofill-ready": (a, b) => finishOrder(autofillFinishCounts[a.id] ?? answerCounts[a.id]?.count, autofillFinishCounts[b.id] ?? answerCounts[b.id]?.count) || Number(!!answerCounts[a.id]) - Number(!!answerCounts[b.id]) || docsFirst(a, b),
    "technical-high": (a, b) => assessmentOrder(openingAssessmentValuesFor(a).technicalFit, openingAssessmentValuesFor(b).technicalFit),
    "technical-low": (a, b) => assessmentOrder(openingAssessmentValuesFor(a).technicalFit, openingAssessmentValuesFor(b).technicalFit, true),
    "remote-high": (a, b) => assessmentOrder(openingAssessmentValuesFor(a).remoteFit, openingAssessmentValuesFor(b).remoteFit),
    "remote-low": (a, b) => assessmentOrder(openingAssessmentValuesFor(a).remoteFit, openingAssessmentValuesFor(b).remoteFit, true),
    "wlb-high": (a, b) => assessmentOrder(openingAssessmentValuesFor(a).wlbOutlook, openingAssessmentValuesFor(b).wlbOutlook),
    "wlb-low": (a, b) => assessmentOrder(openingAssessmentValuesFor(a).wlbOutlook, openingAssessmentValuesFor(b).wlbOutlook, true),
    company: (a, b) => collator.compare(a.company, b.company),
    "company-desc": (a, b) => collator.compare(b.company, a.company),
    newest: (a, b) => dateOrder(added(a), added(b), true),
    oldest: (a, b) => dateOrder(added(a), added(b)),
    "posted-newest": (a, b) => dateOrder(timestamp(openingPostedDate(a)), timestamp(openingPostedDate(b)), true),
    "posted-oldest": (a, b) => dateOrder(timestamp(openingPostedDate(a)), timestamp(openingPostedDate(b))),
    "skills-percent": (a, b) => skillMatchOrder(match(a), match(b)) || docsFirst(a, b),
    "skills-count": (a, b) => skillMatchOrder(match(a), match(b), true) || docsFirst(a, b),
  };
  return [...openings].sort((a, b) => comparators[mode](a, b) || collator.compare(a.company, b.company) || collator.compare(a.title, b.title) || collator.compare(a.id, b.id));
}
