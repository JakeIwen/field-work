import type { Store } from "./storage.js";
import type { PullRun } from "./greenhouse-pull-records.js";
import type { GreenhouseSource } from "./greenhouse-source.js";
import { greenhousePacingRate } from "./greenhouse-pacing.js";
import { currentGreenhouseSearch } from "./greenhouse-query-plan.js";
import { recordGreenhouseSearchPage } from "./greenhouse-pull-discovery.js";

export async function searchGreenhousePullPage(
  store: Store,
  source: GreenhouseSource,
  captured: PullRun,
  lifecycle: {
    active: () => PullRun | undefined;
    save: (run: PullRun) => void;
    notify: () => void;
    clock: () => number;
  },
) {
  const search = currentGreenhouseSearch(captured);
  const page = await source.page(
    search.query,
    captured.page,
    search.employmentTypes,
    {
      nonce: captured.searchNonce ?? captured.id,
      pacingRate: captured.pacingRate ?? greenhousePacingRate(store),
      onTransport: (searchTransport, searchTransportNote) => {
        const run = lifecycle.active();
        if (
          run &&
          (run.searchTransport !== searchTransport ||
            run.searchTransportNote !== searchTransportNote)
        )
          lifecycle.save({ ...run, searchTransport, searchTransportNote });
      },
    },
  );
  const run = lifecycle.active();
  if (!run) return;
  recordGreenhouseSearchPage(store, run, page, lifecycle.clock());
  store.autoExport();
  lifecycle.notify();
}
