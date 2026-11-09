import { greenhouseSearchIdentity } from "../shared/greenhouse-search.js";
import type { Store } from "./storage.js";
import type { PullRun } from "./greenhouse-pull-records.js";
import { recordGreenhousePacingRecovery } from "./greenhouse-pacing.js";
import { triageGreenhouseSearchCards } from "./opening-pull/card-triage.js";
import {
  greenhousePageActivity,
  retainGreenhouseActivity,
} from "./greenhouse-pull-activity.js";
import type { GreenhousePage } from "./greenhouse-search.js";
import {
  advanceGreenhouseSearch,
  currentGreenhouseSearch,
} from "./greenhouse-query-plan.js";

export function greenhouseSearchProgress(run: PullRun, page?: GreenhousePage) {
  const identity = greenhouseSearchIdentity(
    page ?? currentGreenhouseSearch(run),
  );
  const ids = new Set(
    run.pages
      .filter((saved) => greenhouseSearchIdentity(saved).key === identity.key)
      .flatMap((saved) => saved.ids),
  );
  for (const card of page?.cards ?? []) ids.add(`${card.board}:${card.id}`);
  return page?.more === false
    ? `Searched “${identity.label}” to the end: ${ids.size} results`
    : `Searching “${identity.label}”: ${ids.size} results so far`;
}

export function recordGreenhouseSearchPage(
  store: Store,
  run: PullRun,
  page: GreenhousePage,
  at: number,
) {
  const identity = greenhouseSearchIdentity(page);
  if (
    identity.key !==
      greenhouseSearchIdentity(currentGreenhouseSearch(run)).key ||
    page.page !== run.page ||
    page.status !== 200
  )
    throw Error("Unexpected search page; pagination was not advanced");
  const ids = page.cards.map((card) => `${card.board}:${card.id}`);
  if (
    page.more &&
    (!ids.length ||
      run.pages.some(
        (saved) =>
          greenhouseSearchIdentity(saved).key === identity.key &&
          saved.ids.join() === ids.join(),
      ))
  )
    throw Error(
      "Greenhouse repeated a page or returned no new rows while more results remain. Retry the saved page.",
    );
  store.transaction(() => {
    const counts = triageGreenhouseSearchCards(store, run, page);
    store.put("greenhouse_pull_run", run.id, {
      ...retainGreenhouseActivity(
        store,
        recordGreenhousePacingRecovery(
          store,
          greenhousePageActivity(run, page, counts, at),
          at,
        ),
      ),
      ...advanceGreenhouseSearch(run, page.more),
      searchRetry: undefined,
      bridgeFailureCount: 0,
      searchInProgress: page.more,
      pages: [
        ...run.pages,
        {
          query: page.query,
          pacingRate: run.pacingRate,
          employmentTypes: [...identity.employmentTypes],
          page: page.page,
          ids,
          more: page.more,
          status: 200,
          at: page.at,
        },
      ],
      phase: greenhouseSearchProgress(run, page),
      updatedAt: new Date(at).toISOString(),
    });
  });
}
