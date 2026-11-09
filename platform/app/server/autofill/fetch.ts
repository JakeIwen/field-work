import { tunableOr } from "../tunables.js";
import type { TunableKey } from "../../shared/tunables.js";
import { setTimeout as pause } from "node:timers/promises";
import {
  publicCareersFetch,
  type CareersFetch,
  type CareersResponse,
} from "../careers/http.js";
import { retryTime } from "../greenhouse-source.js";
import { HttpError, type Store } from "../storage.js";
import { generationSignal } from "../generation-control.js";
import { postingGoneNotice } from "../../shared/opening-availability.js";

import {
  describeAutofillFetchFailure,
  type AutofillFetchAttempt,
  type FetchFailureCause,
} from "./fetch-errors.js";

type FetchOptions = {
  read?: CareersFetch;
  store?: Store;
  onAttempt?: (attempt: AutofillFetchAttempt) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function autofillFetchOptions(
  url: string,
  signal: AbortSignal,
  options: FetchOptions,
) {
  const value = (key: TunableKey) => tunableOr(options.store, key);
  const read =
    options.read ??
    ((value: string) =>
      publicCareersFetch(
        value,
        signal,
        undefined,
        () => options.store?.settings() ?? {},
      ));
  const wait =
    options.wait ??
    ((ms: number, current: AbortSignal) =>
      pause(ms, undefined, { signal: current }));
  const endpoint =
    new URL(url).hostname === "boards-api.greenhouse.io"
      ? "question API"
      : "application form";
  return { value, read, wait, endpoint };
}

/** Retry only temporary read failures; never replay mutations or bypass a cooldown. */
export async function fetchAutofillPage(
  url: string,
  signal: AbortSignal,
  options: FetchOptions = {},
) {
  const { value, read, wait, endpoint } = autofillFetchOptions(
    url,
    signal,
    options,
  );
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const started = Date.now();
    let page: CareersResponse | undefined;
    let cause: string | undefined;
    let causes: FetchFailureCause[] | undefined;
    const report = (
      outcome: AutofillFetchAttempt["outcome"],
      retryDelayMs?: number,
    ) =>
      options.onAttempt?.({
        url,
        attempt: attempt + 1,
        elapsedMs: Date.now() - started,
        outcome,
        ...(page ? { status: page.status } : {}),
        ...(causes ? { causes } : {}),
        ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
      });
    try {
      page = await read(url);
    } catch (error) {
      const failure = describeAutofillFetchFailure(error);
      cause = failure.summary;
      causes = failure.causes;
      if (signal.aborted) {
        report("cancelled");
        signal.throwIfAborted();
      }
      if (!failure.temporary) {
        report("failed");
        throw new HttpError(
          502,
          `Could not read the Greenhouse ${endpoint}: ${cause}. Saved work is preserved.`,
        );
      }
    }
    const temporaryStatus =
      page && [408, 429, 500, 502, 503, 504].includes(page.status);
    if (page && !temporaryStatus) {
      report(page.status === 200 ? "succeeded" : "failed");
      return page;
    }
    cause ??= page ? `HTTP ${page.status}` : "temporary network failure";
    const delay =
      page?.retryAfter || page?.status === 429
        ? Date.parse(retryTime(page?.retryAfter)) - Date.now()
        : value("autofill.fetchRetryDelayMs") * 2 ** attempt;
    if (delay > value("autofill.fetchMaxWaitS") * 1000) {
      report("failed", delay);
      throw new HttpError(
        page?.status === 429 ? 429 : 503,
        `Greenhouse ${endpoint} returned ${cause}. Retry after ${new Date(Date.now() + delay).toISOString()}. Saved work is preserved.`,
      );
    }
    if (attempt + 1 >= value("autofill.fetchAttempts")) {
      report("failed");
      throw new HttpError(
        503,
        `Could not read the Greenhouse ${endpoint} after ${attempt + 1} attempts: ${cause}. Saved work is preserved; retry preparation to continue.`,
      );
    }
    report("retrying", delay);
    await wait(delay, signal);
  }
}

export function readableGreenhousePage(page: CareersResponse) {
  if (page.status === 429)
    throw new HttpError(
      429,
      "Greenhouse is limiting requests. Wait before trying again; your saved scripts are unchanged.",
    );
  if (page.status === 404 || page.status === 410)
    throw new HttpError(
      422,
      `Greenhouse ${postingGoneNotice} (HTTP ${page.status}), so it looks closed. Validate openings on the Openings page confirms closures and hides them; your saved scripts are unchanged.`,
    );
  if (page.status !== 200)
    throw new HttpError(
      422,
      `Greenhouse returned HTTP ${page.status}. The form could not be verified; your saved scripts are unchanged.`,
    );
  return page;
}

export function settledGreenhousePages(
  results: PromiseSettledResult<CareersResponse>[],
) {
  return results.map((result) => {
    if (result.status === "fulfilled")
      return readableGreenhousePage(result.value);
    if (result.reason instanceof HttpError) throw result.reason;
    throw new HttpError(
      422,
      `Could not read the current Greenhouse form: ${describeAutofillFetchFailure(result.reason).summary}. Your saved scripts are unchanged; try again later.`,
    );
  });
}

export function autofillReader(
  store: Store,
  openingId: string,
  options: Pick<FetchOptions, "read" | "wait"> = {},
): CareersFetch {
  return (url) =>
    fetchAutofillPage(url, generationSignal(store), {
      ...options,
      store,
      onAttempt: (attempt) => {
        if (attempt.outcome === "succeeded" && attempt.attempt === 1) return;
        store.journal(
          "autofill_fetch",
          `Greenhouse read ${attempt.outcome} (attempt ${attempt.attempt})`,
          openingId,
          attempt,
        );
      },
    });
}
