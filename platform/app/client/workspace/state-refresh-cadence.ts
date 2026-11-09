import { tunables } from "../../shared/tunables";
import { singleFlightRefresh } from "./state-refresh";



type VisibilitySource = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
};

/** Explicit reads stay immediate; invalidations share a visibility-aware, bounded cadence. */
export function createStateRefreshCadence(load: () => Promise<void>, visibility: VisibilitySource = document, timing: () => { coalesceMs: number; minIntervalMs: number } = () => ({ coalesceMs: tunables["browser.refreshBatchMs"].default, minIntervalMs: tunables["browser.refreshSpacingS"].default * 1000 })) {
  let stale = false, loading = false, observing = false;
  let readyAt = 0, lastStarted = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (!observing || !stale || loading || visibility.visibilityState === "hidden" || timer !== undefined) return;
    const delay = Math.max(0, readyAt - Date.now(), lastStarted + timing().minIntervalMs - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      if (visibility.visibilityState !== "hidden") void reload().catch(() => {});
    }, delay);
  };
  const reload = singleFlightRefresh(async () => {
    cancel();
    loading = true;
    stale = false;
    // Measure actual request starts, not calls queued behind a slower single-flight read.
    lastStarted = Date.now();
    try { await load(); }
    finally { loading = false; schedule(); }
  });
  const invalidate = () => {
    if (stale) return;
    stale = true;
    // Keep the first invalidation's window so continuous events cannot starve progress.
    readyAt = Date.now() + timing().coalesceMs;
    schedule();
  };
  const visible = () => {
    cancel();
    if (visibility.visibilityState !== "hidden") {
      readyAt = Date.now();
      schedule();
    }
  };
  const observe = () => {
    observing = true;
    visibility.addEventListener("visibilitychange", visible);
    schedule();
    return () => {
      observing = false;
      cancel();
      visibility.removeEventListener("visibilitychange", visible);
    };
  };
  return { reload, invalidate, observe };
}
