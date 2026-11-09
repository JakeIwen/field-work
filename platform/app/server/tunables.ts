// Read at the point of use, never at module load: settings are live and do not
// require a restart. Work already waiting keeps the value it previously read.
import type { DatabaseSync } from "node:sqlite";
import {
  tunables,
  tunableValue,
  type TunableKey,
  type TunableSettings,
} from "../shared/tunables.js";
import type { Store } from "./storage.js";
import { cachedStateRead } from "./storage-state-cache.js";

type TimeUnit = "ms" | "s" | "min" | "days";
export type TimeTunableKey = {
  [K in TunableKey]: (typeof tunables)[K]["unit"] extends TimeUnit ? K : never;
}[TunableKey];
const milliseconds = { ms: 1, s: 1000, min: 60_000, days: 86_400_000 } as const;

function parseSavedTunables(db: DatabaseSync): TunableSettings["tunables"] {
  try {
    const row = db
      .prepare("SELECT json FROM records WHERE kind='settings' AND id='main'")
      .get();
    if (typeof row?.json === "string") {
      const parsed: unknown = JSON.parse(row.json);
      const saved = (parsed as TunableSettings | null)?.tunables;
      if (saved && typeof saved === "object") return { ...saved };
    }
  } catch {
    /* Startup and migrations can read before the settings row exists. */
  }
  return {};
}

/** The saved overrides read straight from the settings row (not through
 * `Store.settings()`, which also computes schedule times). The parse is reused
 * until a settings write, rollback or other connection's commit, so a lookup
 * between saves is a map read while a saved change is visible on the next call. */
export function savedTunables(
  store: Pick<Store, "db">,
): TunableSettings["tunables"] {
  return cachedStateRead(
    store as Store,
    "tunable-overrides",
    ["settings"],
    () => parseSavedTunables(store.db),
  );
}

export function tunable(store: Pick<Store, "db">, key: TunableKey): number {
  return tunableValue({ tunables: savedTunables(store) }, key);
}

export function tunableMs(
  store: Pick<Store, "db">,
  key: TimeTunableKey,
): number {
  return tunableToMs(key, tunable(store, key));
}

/** For callers that may run without a Store (isolated helpers and tests): the
 * registry default applies when there is none. */
export function tunableOr(
  store: Pick<Store, "db"> | undefined,
  key: TunableKey,
): number {
  return store ? tunable(store, key) : tunables[key].default;
}

export function tunableMsOr(
  store: Pick<Store, "db"> | undefined,
  key: TimeTunableKey,
): number {
  return store
    ? tunableMs(store, key)
    : tunableToMs(key, tunables[key].default);
}

function tunableToMs(key: TimeTunableKey, value: number): number {
  const unit = tunables[key].unit;
  if (!Object.hasOwn(milliseconds, unit))
    throw new TypeError(`Tunable "${key}" is not a time value.`);
  return value * milliseconds[unit as TimeUnit];
}
