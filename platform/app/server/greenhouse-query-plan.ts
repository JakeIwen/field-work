import type {
  PullRun,
  PullCandidate,
  PullQueryCursor,
} from "./greenhouse-pull-records.js";
import {
  greenhouseSearchIdentity,
  regularGreenhouseEmploymentTypes,
  defaultGreenhouseEmploymentScope,
  focusedGreenhouseEmploymentTypes,
  type GreenhouseEmploymentType,
  type GreenhouseSearch,
} from "../shared/greenhouse-search.js";

import { greenhouseDefaultRegularSearchTerms } from "../shared/greenhouse-policy.js";

export const greenhouseQueries = greenhouseDefaultRegularSearchTerms;
const legacyQueries = [
  "full stack",
  "full-stack",
  "software",
  "software developer",
];

export function newGreenhouseQueryPlan(
  previous?: PullRun,
  searchTerms: string[] = [],
  employmentScope: GreenhouseEmploymentType[] = defaultGreenhouseEmploymentScope,
  regularSearchTerms: string[] = greenhouseDefaultRegularSearchTerms,
): PullQueryCursor[] {
  const previousFirst =
    previous?.queryPlan?.find(
      (cursor) =>
        (
          previous?.policy?.regularSearchTerms ??
          greenhouseDefaultRegularSearchTerms
        ).includes(cursor.query) &&
        greenhouseSearchIdentity(cursor).key ===
          greenhouseSearchIdentity({
            query: cursor.query,
            employmentTypes:
              previous?.guidance?.employmentScope ??
              regularGreenhouseEmploymentTypes,
          }).key,
    )?.query ?? (previous ? legacyQueries[0] : undefined);
  const start = previousFirst
    ? (regularSearchTerms.indexOf(previousFirst) + 1) %
      regularSearchTerms.length
    : 0;
  const standard = [
    ...regularSearchTerms.slice(start),
    ...regularSearchTerms.slice(0, start),
  ];
  const focused = searchTerms.filter(
    (term) => !regularSearchTerms.includes(term),
  );
  // Extra focused searches help surface non-full-time roles within a mixed scope.
  const focusedTypes = employmentScope.includes("full_time")
    ? focusedGreenhouseEmploymentTypes.filter((type) =>
        employmentScope.includes(type),
      )
    : [];
  const searches: GreenhouseSearch[] = [
    ...standard.flatMap((query, index) => [
      ...(focused[index]
        ? [{ query: focused[index], employmentTypes: employmentScope }]
        : []),
      ...focusedTypes.map((type) => ({ query, employmentTypes: [type] })),
      { query, employmentTypes: employmentScope },
    ]),
    // A custom regular list can be shorter than the selected extra-term list.
    ...focused.slice(standard.length).map((query) => ({
      query,
      employmentTypes: employmentScope,
    })),
  ];
  return [
    ...new Map(
      searches.map((search) => [greenhouseSearchIdentity(search).key, search]),
    ).values(),
  ].map((search) => ({
    ...search,
    employmentTypes: [
      ...(search.employmentTypes ?? regularGreenhouseEmploymentTypes),
    ],
    page: 1,
    exhausted: false,
  }));
}

/** Old runs retain their original terms, page and completed-query evidence. */
export function greenhouseQueryPlan(run: PullRun): PullQueryCursor[] {
  return (
    run.queryPlan ??
    legacyQueries.map((query, index) => {
      const pages = run.pages.filter((page) => page.query === query);
      const last = pages.at(-1);
      return {
        query,
        page: index === run.queryIndex ? run.page : last ? last.page + 1 : 1,
        exhausted: index < run.queryIndex || last?.more === false,
      };
    })
  );
}

export const currentGreenhouseSearch = (run: PullRun): GreenhouseSearch =>
  greenhouseQueryPlan(run)[run.queryIndex] ?? { query: "" };
export const currentGreenhouseQuery = (run: PullRun) =>
  currentGreenhouseSearch(run).query;
export const greenhouseSearchPending = (run: PullRun) =>
  greenhouseQueryPlan(run).some((query) => !query.exhausted);

export function greenhouseSearchCoverage(run: PullRun) {
  return greenhouseQueryPlan(run).map((search) => ({
    query: search.query,
    employmentTypes: greenhouseSearchIdentity(search).employmentTypes,
    exhausted: search.exhausted,
    pages: run.pages.filter(
      (page) =>
        greenhouseSearchIdentity(page).key ===
        greenhouseSearchIdentity(search).key,
    ).length,
  }));
}

function candidateQueries(run: PullRun, candidate: PullCandidate) {
  return (
    candidate.discoveredBy ??
    run.pages
      .filter((page) =>
        page.ids.includes(`${candidate.card.board}:${candidate.card.id}`),
      )
      .map((page) => greenhouseSearchIdentity(page).key)
  );
}

function reviewOrder(run: PullRun) {
  const plan = greenhouseQueryPlan(run);
  const cursor = run.reviewCursor ?? run.queryIndex % plan.length;
  return [...plan.slice(cursor), ...plan.slice(0, cursor)];
}

export function rotatedGreenhouseCandidate(
  run: PullRun,
  candidates: PullCandidate[],
) {
  for (const group of reviewOrder(run)) {
    const key = greenhouseSearchIdentity(group).key;
    const candidate = candidates.find((c) =>
      candidateQueries(run, c).includes(key),
    );
    if (candidate) return candidate;
  }
  return candidates[0];
}

export function nextGreenhouseReviewCursor(
  run: PullRun,
  candidate: PullCandidate,
) {
  const origins = candidateQueries(run, candidate);
  const group = reviewOrder(run).find((search) =>
    origins.includes(greenhouseSearchIdentity(search).key),
  );
  const plan = greenhouseQueryPlan(run);
  return group
    ? (plan.findIndex(
        (search) =>
          greenhouseSearchIdentity(search).key ===
          greenhouseSearchIdentity(group).key,
      ) +
        1) %
        plan.length
    : run.reviewCursor;
}

export function advanceGreenhouseSearch(run: PullRun, more: boolean) {
  const plan = greenhouseQueryPlan(run).map((query, index) =>
    index === run.queryIndex
      ? { ...query, page: query.page + 1, exhausted: !more }
      : query,
  );
  const pending = plan.filter((query) => !query.exhausted);
  const round = Math.min(...pending.map((query) => query.page));
  const queryIndex = plan.findIndex(
    (query) => !query.exhausted && query.page === round,
  );
  return queryIndex < 0
    ? { queryPlan: plan, queryIndex: plan.length, page: 1 }
    : { queryPlan: plan, queryIndex, page: plan[queryIndex].page };
}
