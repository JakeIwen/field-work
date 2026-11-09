import type { StatementSync } from "node:sqlite";
import type { Records } from "./records.js";
import type { Store } from "./storage.js";
import type { TaskSummary } from "../shared/task-records.js";
import { clearReadCache } from "./storage-read-cache.js";

type Kind = keyof Records;
type Entry = { versions: number[]; value: unknown };
const caches = new WeakMap<Store, StateCache>();
const immutableRecords = new WeakSet<object>();

/** These projections contain only JSON records. Freezing prevents a consumer from
 * silently changing what a later request sees without a corresponding write. */
function freezeRecords<T>(value: T): T {
  if (value && typeof value === "object" && !immutableRecords.has(value)) {
    for (const child of Object.values(value)) freezeRecords(child);
    Object.freeze(value);
    immutableRecords.add(value);
  }
  return value;
}

class StateCache {
  private versions = new Map<string, number>();
  private entries = new Map<string, Entry>();
  private changedTasks = new Set<string>();
  private summaries?: Map<string, TaskSummary>;
  private dataVersion: StatementSync;
  private lastDataVersion: unknown;
  private projectionDepth = 0;
  private invalidation = 0;
  private disposals = new Set<{
    dispose: () => void;
    kinds?: readonly Kind[];
  }>();

  onInvalidation(dispose: () => void, kinds?: readonly Kind[]) {
    const entry = { dispose, kinds };
    this.disposals.add(entry);
    return () => {
      this.disposals.delete(entry);
    };
  }

  constructor(private store: Store) {
    this.dataVersion = store.db.prepare("PRAGMA data_version");
    this.lastDataVersion = this.dataVersion.get()?.data_version;
  }

  changed(kind: string, id: string) {
    this.versions.set(kind, (this.versions.get(kind) ?? 0) + 1);
    if (kind === "task") this.changedTasks.add(id);
    for (const { dispose, kinds } of this.disposals)
      if (!kinds || kinds.includes(kind as Kind)) dispose();
    clearReadCache(this.store);
  }

  invalidate() {
    this.invalidation++;
    this.entries.clear();
    this.summaries = undefined;
    this.changedTasks.clear();
    // A rollback or another connection's commit may have changed any kind.
    for (const { dispose } of this.disposals) dispose();
    clearReadCache(this.store);
  }

  private checkExternalWrites() {
    if (this.projectionDepth) return;
    // SQLite changes this connection's counter only when another connection commits.
    const version = this.dataVersion.get()?.data_version;
    if (version !== this.lastDataVersion) this.invalidate();
    this.lastDataVersion = version;
  }

  writeVersion() {
    this.checkExternalWrites();
    return JSON.stringify([this.invalidation, [...this.versions]]);
  }

  project<T>(read: () => T): T {
    this.checkExternalWrites();
    this.projectionDepth++;
    try {
      return read();
    } finally {
      this.projectionDepth--;
      // A writer can commit between dependent reads. Do not retain a projection
      // combining earlier personal/application inputs with a newer database view.
      this.checkExternalWrites();
    }
  }

  read<T>(key: string, kinds: readonly Kind[], build: () => T): T {
    this.checkExternalWrites();
    const versions = kinds.map((kind) => this.versions.get(kind) ?? 0);
    const entry = this.entries.get(key);
    if (entry && versions.every((version, i) => version === entry.versions[i]))
      // Each named projection owns its dependency list and return type.
      return entry.value as T;
    const value = freezeRecords(build());
    this.entries.set(key, { versions, value });
    return value;
  }

  tasks(): TaskSummary[] {
    return this.read("tasks", ["task"], () => {
      const summaries = this.summaries ?? new Map<string, TaskSummary>();
      const rows = this.store.db
        .prepare("SELECT id FROM records WHERE kind='task' ORDER BY rowid")
        .all();
      const ids = new Set(rows.map((row) => String(row.id)));
      for (const id of summaries.keys()) if (!ids.has(id)) summaries.delete(id);
      for (const id of ids) {
        if (summaries.has(id) && !this.changedTasks.has(id)) continue;
        const summary = this.store.taskSummaries(id)[0];
        if (summary) summaries.set(id, freezeRecords(summary));
        else summaries.delete(id);
      }
      this.summaries = summaries;
      this.changedTasks.clear();
      return [...ids].flatMap((id) => {
        const summary = summaries.get(id);
        return summary ? [summary] : [];
      });
    });
  }
}

/** Connection-local triggers see every records write, including bulk SQL and
 * migrations. Versions advance immediately so reads inside transactions are fresh. */
export function initializeStateCache(store: Store, readOnly = false) {
  const cache = new StateCache(store);
  caches.set(store, cache);
  if (readOnly) return;
  store.db.function("state_cache_changed", (kind, id) => {
    cache.changed(String(kind), String(id));
    return null;
  });
  for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
    const row = operation === "DELETE" ? "OLD" : "NEW";
    store.db.exec(`CREATE TEMP TRIGGER state_cache_${operation.toLowerCase()}
      AFTER ${operation} ON main.records BEGIN
        SELECT state_cache_changed(${row}.kind, ${row}.id);
      END`);
  }
  store.db.exec(`CREATE TEMP TRIGGER state_cache_moved_record
    AFTER UPDATE OF kind, id ON main.records
    WHEN OLD.kind != NEW.kind OR OLD.id != NEW.id BEGIN
      SELECT state_cache_changed(OLD.kind, OLD.id);
    END`);
}

function cacheFor(store: Store) {
  const cache = caches.get(store);
  if (!cache) throw new Error("Store state cache was not initialized");
  return cache;
}

export function cachedStateRead<T>(
  store: Store,
  key: string,
  kinds: readonly Kind[],
  read: () => T,
): T {
  return cacheFor(store).read(key, kinds, read);
}

export function withStateCache<T>(store: Store, read: () => T): T {
  return cacheFor(store).project(read);
}

export function stateTaskSummaries(store: Store) {
  return cacheFor(store).tasks();
}

export function isCachedStateValue(value: unknown): value is object {
  return !!value && typeof value === "object" && immutableRecords.has(value);
}

/** A record-only plan can be reused until a write, rollback or external commit.
 * Files and runtime state are deliberately not covered by this revision. */
export function stateCacheWriteVersion(store: Store): string {
  return cacheFor(store).writeVersion();
}

/** Release short-lived derived plans as soon as their record revision expires.
 * With `kinds`, only writes to those kinds (and rollbacks or other connections'
 * commits, which could have touched anything) call back. */
export function onStateCacheInvalidation(
  store: Store,
  dispose: () => void,
  kinds?: readonly Kind[],
) {
  return cacheFor(store).onInvalidation(dispose, kinds);
}

export function invalidateStateCache(store: Store) {
  cacheFor(store).invalidate();
}
