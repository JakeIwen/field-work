import type { AppState, Opening } from "../../shared/types";
import { hostedApplication } from "../../shared/application-host";
import { appliedOpeningIds } from "../../shared/opening-applications";
import { openingVisibleInList } from "../../shared/opening-availability";
import { openingAssessmentValues, openingAssessmentValuesFor } from "../../shared/opening-assessments";
import { openingSkills } from "../../shared/opening-skills";
import { textMatch } from "../ui/text-match";
import { emptyOpeningAge, matchesOpeningAge } from "./OpeningAgeFilter";
import { emptySkillFilter, matchesSkillFilter, normalizeSkillFilter } from "./skills/opening-skill-filter";
import { openingSort } from "./opening-sort";

export const openingReviewOptions = [
  ["unreviewed", "Not yet reviewed"],
  ["changed", "Changed since my review"],
] as const;

export const emptyOpeningFilters = {
  ...emptyOpeningAge,
  skills: emptySkillFilter,
  query: "",
  technical: [] as string[],
  remote: [] as string[],
  wlb: [] as string[],
  pay: "",
  saved: false,
  autofillEligible: true,
  nonGreenhouse: false,
  dismissed: false,
  applied: false,
  history: false,
  closed: false,
  review: [] as string[],
  sort: "docs-first",
};
export type OpeningFilters = typeof emptyOpeningFilters;

function filterSelections(value: unknown, options: readonly string[]): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return options.filter(option => values.includes(option));
}

export function normalizeOpeningFilters(filters: Record<string, unknown>): OpeningFilters {
  // Saved filters from before Priority was removed may still carry its key.
  const { priority: _retired, ...saved } = filters;
  return {
    ...emptyOpeningFilters,
    ...saved,
    technical: filterSelections(filters.technical, openingAssessmentValues),
    remote: filterSelections(filters.remote, openingAssessmentValues),
    wlb: filterSelections(filters.wlb, openingAssessmentValues),
    review: filterSelections(filters.review, openingReviewOptions.map(([value]) => value)),
    skills: normalizeSkillFilter(filters.skills),
    sort: openingSort(filters.sort),
  };
}

export function matchesOpeningFilters(
  o: Opening,
  filters: OpeningFilters,
  personal: AppState["personal"],
  applied: ReadonlySet<string>,
  hiddenIds: ReadonlySet<string>,
) {
  const p = personal[o.id] || {};
  const ratings = openingAssessmentValuesFor(o);
  const payValues = (o.salaryBands || [])
    .filter((b) => b.basis === "published base" && b.currency === "USD")
    .map((b) => b.max);
  return (
    openingVisibleInList(o, filters) &&
    !hiddenIds.has(o.id) &&
    (filters.applied || !applied.has(o.id)) &&
    (!filters.autofillEligible || !!hostedApplication(o.url)) &&
    (!filters.nonGreenhouse || !hostedApplication(o.url)) &&
    matchesOpeningAge(o, filters) &&
    matchesSkillFilter(openingSkills(o), filters.skills) &&
    textMatch(filters.query, o.company, o.title, o.requirements, o.why, o.location) &&
      (!filters.technical.length || filters.technical.includes(ratings.technicalFit)) &&
    (!filters.remote.length || filters.remote.includes(ratings.remoteFit)) &&
    (!filters.wlb.length || filters.wlb.includes(ratings.wlbOutlook)) &&
    (!filters.saved || p.saved) &&
    (filters.dismissed || !p.dismissed) &&
    (!filters.pay ||
      (filters.pay === "published"
        ? payValues.length > 0
        : filters.pay === "unknown"
          ? payValues.length === 0
          : payValues.some((n) => n >= Number(filters.pay)))) &&
    (!filters.review.length || filters.review.some(review =>
      review === "unreviewed" ? !p.reviewedHash : p.reviewedHash && p.reviewedHash !== o.hash))
  );
}

export function filterOpenings(state: AppState, filters: OpeningFilters, hiddenIds: ReadonlySet<string> = new Set()) {
  const applied = appliedOpeningIds(state.applications);
  return state.openings.filter(opening => matchesOpeningFilters(opening, filters, state.personal, applied, hiddenIds));
}
