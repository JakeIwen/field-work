import type { FSWatcher } from "chokidar";
import { diagnosticLog } from "../diagnostic-log.js";
import { onStateCacheInvalidation } from "../storage-state-cache.js";
import type { Store } from "../storage.js";
import { tunable } from "../tunables.js";

/** Polling timing of the research-source watcher, read from saved settings. */
export function watcherTiming(store: Store) {
  return {
    interval: tunable(store, "server.sourcePollMs"),
    binaryInterval: tunable(store, "server.binaryPollMs"),
    awaitWriteFinish: {
      stabilityThreshold: tunable(store, "server.fileStableMs"),
      pollInterval: tunable(store, "server.fileStablePollMs"),
    },
  };
}

export type SourceWatcherHost = {
  watcher: () => FSWatcher | undefined;
  stopping: () => boolean;
  /** Called once the previous watcher is closed and is still the current one. */
  restart: (previous: FSWatcher) => void;
};

/** Close and restart the watcher when a saved timing change makes the running one
 * stale. Only settings writes (and rollbacks or other connections' commits)
 * trigger a check, so ordinary record writes never compute timing. */
export function followWatcherTiming(
  store: Store,
  timing: ReturnType<typeof watcherTiming>,
  host: SourceWatcherHost,
) {
  let pending = false;
  return onStateCacheInvalidation(store, () => {
    if (pending) return;
    pending = true;
    // SQL invalidation fires inside writes; inspect the final committed settings afterward.
    queueMicrotask(() => {
      pending = false;
      const previous = host.watcher();
      if (!previous || previous.closed || host.stopping()) return;
      if (JSON.stringify(timing) === JSON.stringify(watcherTiming(store)))
        return;
      void previous
        .close()
        .then(() => {
          if (!host.stopping() && host.watcher() === previous)
            host.restart(previous);
        })
        .catch((error) => {
          diagnosticLog(
            "error",
            "workspace-runtime",
            "Could not update file watcher timing",
            {},
            error,
          );
        });
    });
  }, ["settings"]);
}
