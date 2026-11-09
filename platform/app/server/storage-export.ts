import { tunableMs } from "./tunables.js";
import { diagnosticLog } from "./diagnostic-log.js";
import path from "node:path";
import { statSync } from "node:fs";
import type { Store } from "./storage.js";
import {
  clearPersonalExportChanges,
  personalExportChanges,
} from "./storage-export-dirty.js";
import { writePersonalExport } from "./storage-export-fragments.js";

type ExportStore = Pick<Store, "dataDir" | "db" | "flushExport">;
type PendingExport = {
  firstAt: number;
  lastAt?: number;
  failedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  failures?: number;
  loggedAt?: number;
};
const pending = new WeakMap<ExportStore, PendingExport>();
const completed = new WeakMap<ExportStore, number>();
const closing = new WeakSet<ExportStore>();
function lastCompleted(store: ExportStore) {
  let at = completed.get(store);
  if (at === undefined) {
    try {
      const file = statSync(path.join(store.dataDir, "personal-export.json"));
      if (file.isFile()) at = Math.min(Date.now(), file.mtimeMs);
    } catch {
      /* The first snapshot has no previous interval to honor. */
    }
    completed.set(store, at ?? -Infinity);
  }
  return at ?? -Infinity;
}

function armExport(store: ExportStore, state: PendingExport, delay: number) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    // A caller may have requested this timer inside a transaction that rolled back.
    if (!state.failures && !personalExportChanges(store).requested) {
      pending.delete(store);
      return;
    }
    try {
      store.flushExport();
    } catch {
      // The flush boundary reports failures and arms the single retry timer.
    }
  }, delay);
  state.timer.unref?.();
}

function retryDelay(store: ExportStore, state: PendingExport) {
  return Math.min(
    tunableMs(store, "records.exportRetryCapMin"),
    tunableMs(store, "records.exportRetryFirstS") *
      2 ** ((state.failures ?? 1) - 1),
  );
}

/** When a pending export is due, from the live settings: after the quiet period
 * or the debounce cap, but not before the minimum interval since the last one. */
function exportDueAt(store: ExportStore, state: PendingExport) {
  const debouncedAt = Math.min(
    (state.lastAt ?? state.firstAt) + tunableMs(store, "records.exportQuietS"),
    state.firstAt + tunableMs(store, "records.exportDebounceCapS"),
  );
  const eligibleAt =
    lastCompleted(store) + tunableMs(store, "records.exportMinIntervalMin");
  return state.firstAt < eligibleAt ? eligibleAt : debouncedAt;
}

function retryExport(store: ExportStore, state: PendingExport, error: unknown) {
  pending.set(store, state);
  if (closing.has(store)) return;
  state.failures = (state.failures ?? 0) + 1;
  const delay = retryDelay(store, state);
  const at = Date.now();
  state.failedAt = at;
  if (
    state.loggedAt === undefined ||
    at - state.loggedAt >= tunableMs(store, "records.exportLogIntervalS")
  ) {
    diagnosticLog(
      "error",
      "personal-export",
      "Personal export failed; SQLite changes are retained. Retrying.",
      { retryDelayMs: delay, failures: state.failures },
      error,
    );
    state.loggedAt = at;
  }
  armExport(store, state, delay);
}

export function schedulePersonalExport(store: ExportStore) {
  if (closing.has(store)) return;
  // Progress writes remain dirty without requesting an automatic snapshot.
  if (!personalExportChanges(store).requested) return;
  const at = Date.now();
  const state: PendingExport = pending.get(store) ?? { firstAt: at };
  pending.set(store, state);
  // Mutations neither shorten nor postpone failure backoff.
  if (state.failures) return;
  state.lastAt = at;
  armExport(store, state, Math.max(0, exportDueAt(store, state) - at));
}

/** A saved timing change applies to an export that is already waiting: the
 * pending timer is recomputed from the live values instead of keeping the delay
 * it was armed with. */
export function reschedulePersonalExport(store: ExportStore) {
  const state = pending.get(store);
  if (!state?.timer || closing.has(store)) return;
  const due = state.failures
    ? (state.failedAt ?? Date.now()) + retryDelay(store, state)
    : exportDueAt(store, state);
  armExport(store, state, Math.max(0, due - Date.now()));
}

/** Explicit exports and backups are fresh even when callers only used Store.put. */
export function flushPersonalExport(store: ExportStore) {
  const state = pending.get(store);
  clearTimeout(state?.timer);
  try {
    writePersonalExport(store, personalExportChanges(store).kinds);
    clearPersonalExportChanges(store);
    completed.set(store, Date.now());
    pending.delete(store);
  } catch (error) {
    retryExport(store, state ?? { firstAt: Date.now() }, error);
    throw error;
  }
}

export function closePersonalExport(store: ExportStore) {
  closing.add(store);
  const state = pending.get(store);
  if (!state && !personalExportChanges(store).kinds.size) return;
  clearTimeout(state?.timer);
  try {
    store.flushExport();
  } finally {
    pending.delete(store);
  }
}
