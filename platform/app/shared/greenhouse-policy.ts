import { tunables } from "./tunables-registry.js";
/** The selection conditions a Greenhouse pull applies (owner decision, 2026-10-30: every
 * condition that can drop a posting is visible and chosen at pull start). The
 * saved policy is the default for new pulls; each run captures its own copy with
 * the exclusion lists in effect, and screens, review prompt, log reasons and the
 * Base prompt preview all read that one record. */
export type GreenhousePullPolicy = {
  // Original publication must fall within this many days. The search itself asks
  // Greenhouse for the past ten days, so wider windows need the search changed.
  freshnessDays: number;
  // Explicit required travel above this percentage excludes; null means no cap.
  travelCapPercent: number | null;
  // Exclude roles defined by a programming language absent from the resume.
  excludeMissingLanguage: boolean;
  // Reuse earlier source-backed exclusions and deferrals instead of a new review.
  reuseReviews: boolean;
  // A remembered deferral counts for this long after its decision.
  deferralReuseHours: number;
  // Skip plainly non-software card titles before retrieving the posting.
  titleTriage: boolean;
  // The regular software queries every pull rotates through.
  regularSearchTerms: string[];
};

export const greenhousePolicyVersion = 1;

export const greenhousePolicyBounds = {
  freshnessDays: { min: 1, max: 10 },
  travelCapPercent: { min: 0, max: 100 },
  deferralReuseHours: { min: 1, max: 720 },
  regularSearchTerms: { min: 1, max: 16 },
  searchTerm: 100,
} as const;

// Search cards carry a less reliable date than the posting API, so the card
// check allows this many extra days and leaves borderline cards to the API check.
export const greenhouseCardDateMarginDays =
  tunables["greenhouse.cardDateMarginDays"].default;

/** "one day" / "3 days": how a search-card date margin reads in prompts and UI. */
export function cardDateMarginText(days: number): string {
  return days === 1 ? "one day" : `${days} days`;
}

/** The former fixed rotation; new pulls start from it until the user edits the list. */
export const greenhouseDefaultRegularSearchTerms = [
  "software engineer",
  "full stack",
  "backend",
  "frontend",
  "product engineer",
  "software developer",
  "software",
  "full-stack",
];

export const defaultGreenhousePullPolicy: GreenhousePullPolicy = {
  freshnessDays: 7,
  travelCapPercent: 5,
  excludeMissingLanguage: true,
  reuseReviews: true,
  deferralReuseHours: 72,
  titleTriage: true,
  regularSearchTerms: [...greenhouseDefaultRegularSearchTerms],
};

/** Lists captured at pull start. Title/technology edits affect only later pulls;
 * excluded companies also include live additions as an explicit stop control. */
export type CapturedGreenhousePolicy = GreenhousePullPolicy & {
  policyVersion: typeof greenhousePolicyVersion;
  // Captured alongside freshness; older runs keep the original one-day margin.
  cardDateMarginDays?: number;
  // Empty for legacy projections: no historical capture was recorded.
  capturedAt: string;
  legacy?: boolean;
  titleExcludeTerms: string[];
  technologyExcludeTerms: string[];
  excludedCompanies: string[];
};

export type GreenhousePolicySettings = {
  greenhousePolicy?: GreenhousePullPolicy;
};

const wholeNumberIn = (
  value: unknown,
  { min, max }: { min: number; max: number },
) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

const validSearchTerm = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= greenhousePolicyBounds.searchTerm &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** Validation at the trust boundary: the reason a value is not a policy, or undefined. */
export function greenhousePolicyProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Pull policy must be an object";
  const policy = value as Record<string, unknown>;
  const bounds = greenhousePolicyBounds;
  if (!wholeNumberIn(policy.freshnessDays, bounds.freshnessDays))
    return `Freshness must be whole days from ${bounds.freshnessDays.min} to ${bounds.freshnessDays.max}`;
  if (
    policy.travelCapPercent !== null &&
    !wholeNumberIn(policy.travelCapPercent, bounds.travelCapPercent)
  )
    return `Travel cap must be a whole percentage from ${bounds.travelCapPercent.min} to ${bounds.travelCapPercent.max}, or null for no cap`;
  if (typeof policy.excludeMissingLanguage !== "boolean")
    return "Missing-language exclusion must be true or false";
  if (typeof policy.reuseReviews !== "boolean")
    return "Review reuse must be true or false";
  if (!wholeNumberIn(policy.deferralReuseHours, bounds.deferralReuseHours))
    return `Deferral reuse must be whole hours from ${bounds.deferralReuseHours.min} to ${bounds.deferralReuseHours.max}`;
  if (typeof policy.titleTriage !== "boolean")
    return "Title triage must be true or false";
  const terms = policy.regularSearchTerms;
  if (
    !Array.isArray(terms) ||
    terms.length < bounds.regularSearchTerms.min ||
    terms.length > bounds.regularSearchTerms.max ||
    !terms.every(validSearchTerm)
  )
    return `Regular search terms must be ${bounds.regularSearchTerms.min} to ${bounds.regularSearchTerms.max} texts of at most ${bounds.searchTerm} characters`;
  const normalized = terms.map((term: string) => term.trim().toLowerCase());
  if (new Set(normalized).size !== normalized.length)
    return "Regular search terms must be distinct";
  const known = Object.keys(defaultGreenhousePullPolicy);
  const extra = Object.keys(policy).filter((key) => !known.includes(key));
  if (extra.length) return `Unknown pull policy fields: ${extra.join(", ")}`;
  return undefined;
}

/** The saved policy with defaults filled, so every reader sees a complete policy. */
export function greenhousePullPolicy(
  settings: GreenhousePolicySettings,
): GreenhousePullPolicy {
  const saved = settings.greenhousePolicy;
  if (!saved || greenhousePolicyProblem(saved))
    return {
      ...defaultGreenhousePullPolicy,
      regularSearchTerms: [...greenhouseDefaultRegularSearchTerms],
    };
  return { ...saved, regularSearchTerms: [...saved.regularSearchTerms] };
}
