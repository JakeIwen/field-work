import { migrateRoutineJournal } from "./storage-journal-migration.js";
import { greenhouseEmploymentScopeOrder } from "../shared/greenhouse-search.js";
import type { Opening } from "../shared/types.js";
import type { GreenhouseGuidance } from "../shared/greenhouse-guidance.js";
import {
  normalizeGreenhouseGuidanceInstructions,
  rememberGreenhouseGuidance,
} from "./opening-pull/guidance-history.js";
import { now, type Store } from "./storage.js";

const guidanceHistoryMigrationVersion = 6;

/** Retain the Store startup entry point while applying independent migrations. */
export function migrateOpeningDismissals(store: Store): boolean {
  const dismissalsChanged = migrateDismissalRecords(store);
  const historyChanged = migrateGreenhouseGuidanceHistory(store);
  const journalChanged = migrateRoutineJournal(store);
  return (
    migrateGreenhouseEmploymentScope(store) ||
    journalChanged ||
    historyChanged ||
    dismissalsChanged
  );
}

/** Run before projections so old backups receive the same personal-state conversion. */
function migrateDismissalRecords(store: Store): boolean {
  return store.transaction(() => {
    if (store.db.prepare("SELECT 1 FROM migrations WHERE version=2").get())
      return false;
    const rows = store.db
      .prepare("SELECT id, json FROM records WHERE kind='opening_archive'")
      .all();
    let personalUpdated = 0;
    let openingsRestored = 0;
    for (const row of rows) {
      const id = String(row.id);
      const personal = store.get("personal", id);
      if (!personal?.dismissed) {
        store.put("personal", id, {
          ...personal,
          id,
          dismissed: true,
          version: (personal?.version ?? 0) + 1,
          updatedAt: now(),
        });
        personalUpdated++;
      }
      // A removed source may have left the snapshot as the only saved vacancy.
      // Keep its identity for discovery deduplication and existing applications.
      if (
        !store.get("cache_opening", id) &&
        !store.get("custom_opening", id) &&
        !store.isDeleted("custom_opening", id)
      ) {
        const record = JSON.parse(String(row.json)) as {
          opening: Opening & { archivedAt?: string };
        };
        const { archivedAt: _archivedAt, ...opening } = record.opening;
        store.put("custom_opening", id, { ...opening, id });
        openingsRestored++;
      }
    }
    store.db.prepare("DELETE FROM records WHERE kind='opening_archive'").run();
    if (rows.length)
      store.journal(
        "opening_dismissal_migration",
        `Converted ${rows.length} openings to Not interested`,
        undefined,
        { converted: rows.length, personalUpdated, openingsRestored },
      );
    store.db
      .prepare("INSERT INTO migrations(version,applied_at) VALUES(2,?)")
      .run(now());
    return rows.length > 0;
  });
}

export function migrateGreenhouseGuidanceHistory(store: Store): boolean {
  return store.transaction(() => {
    if (
      store.db
        .prepare("SELECT 1 FROM migrations WHERE version=?")
        .get(guidanceHistoryMigrationVersion)
    )
      return false;
    const appliedAt = now();
    const uses = new Map<string, { createdAt: string; lastUsedAt: string }>();
    const collect = (text: unknown, at: string) => {
      if (typeof text !== "string" || !Number.isFinite(Date.parse(at))) return;
      const instructions = normalizeGreenhouseGuidanceInstructions(text);
      if (!instructions) return;
      at = new Date(at).toISOString();
      const old = uses.get(instructions);
      uses.set(instructions, {
        createdAt: old && old.createdAt < at ? old.createdAt : at,
        lastUsedAt: old && old.lastUsedAt > at ? old.lastUsedAt : at,
      });
    };
    const saved = store.get("settings", "main");
    collect(
      saved?.greenhouseGuidance?.instructions,
      saved?.updatedAt ?? appliedAt,
    );
    for (const run of store.list("greenhouse_pull_run"))
      collect(run.guidance?.instructions, run.createdAt);
    for (const [instructions, dates] of uses)
      rememberGreenhouseGuidance(
        store,
        instructions,
        dates.lastUsedAt,
        dates.createdAt,
      );
    let settingsChanged = false;
    if (
      saved?.greenhouseGuidance &&
      "throughDate" in saved.greenhouseGuidance
    ) {
      const { throughDate: _throughDate, ...guidance } =
        saved.greenhouseGuidance as GreenhouseGuidance & {
          throughDate?: unknown;
        };
      store.put("settings", "main", {
        ...saved,
        greenhouseGuidance: guidance,
        version: saved.version + 1,
      });
      settingsChanged = true;
    }
    store.db
      .prepare("INSERT INTO migrations(version,applied_at) VALUES(?,?)")
      .run(guidanceHistoryMigrationVersion, appliedAt);
    return settingsChanged || uses.size > 0;
  });
}

const employmentScopeMigrationVersion = 7;

export function migrateGreenhouseEmploymentScope(store: Store): boolean {
  return store.transaction(() => {
    if (
      store.db
        .prepare("SELECT 1 FROM migrations WHERE version=?")
        .get(employmentScopeMigrationVersion)
    )
      return false;
    const saved = store.get("settings", "main");
    const guidance = saved?.greenhouseGuidance;
    const changed = Boolean(guidance && !guidance.employmentScope);
    if (guidance && changed) {
      const { employmentTypes = [], ...current } = guidance;
      const scope = new Set<string>(["full_time", ...employmentTypes]);
      // Keep the version check and migration marker in the same startup transaction.
      if (store.get("settings", "main")?.version !== saved.version)
        throw new Error("Settings changed during employment-scope migration");
      store.put("settings", "main", {
        ...saved,
        greenhouseGuidance: {
          ...current,
          employmentScope: greenhouseEmploymentScopeOrder.filter((type) =>
            scope.has(type),
          ),
        },
        version: saved.version + 1,
        updatedAt: now(),
      });
    }
    store.db
      .prepare("INSERT INTO migrations(version,applied_at) VALUES(?,?)")
      .run(employmentScopeMigrationVersion, now());
    return changed;
  });
}
