import type { Store } from "./storage.js";
import {
  normalizeSchedules,
  type ScheduleKey,
  type Schedules,
} from "../shared/schedules.js";

const hour = 3_600_000;
const order: ScheduleKey[] = ["careersScan", "openingValidation"];

// Derives the display-only nextRunAt: the last start plus the interval, or now
// for an enabled schedule that has never run. Disabled schedules have none.
export function withNextRuns(input: unknown, at = Date.now()): Schedules {
  const schedules = normalizeSchedules(input);
  for (const key of order) {
    const s = schedules[key];
    const last = s.lastStartedAt ? Date.parse(s.lastStartedAt) : NaN;
    s.nextRunAt = !s.enabled
      ? null
      : new Date(
          Number.isFinite(last) ? last + s.intervalHours * hour : at,
        ).toISOString();
  }
  return schedules;
}

export type SchedulerDependencies = {
  store: Store;
  scans: { start(mode: "all", requestId: string): unknown };
  validation: { start(): unknown };
  isIdle: () => boolean;
  notify: () => void;
  // Runs before a scheduled careers scan (the HTTP route reindexes first too).
  prepareScan?: () => Promise<unknown>;
  clock?: () => number;
  startDelayMs?: number;
  intervalMs?: number;
  retryMs?: number;
};

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly createdAt: number;
  private readonly failedAt = new Map<ScheduleKey, number>();
  constructor(private deps: SchedulerDependencies) {
    this.createdAt = this.now();
  }
  private now() {
    return this.deps.clock?.() ?? Date.now();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? 60_000,
    );
    this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  due(key: ScheduleKey, schedules = this.schedules()) {
    const s = schedules[key],
      at = this.now();
    if (!s.enabled) return false;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && at - failed < (this.deps.retryMs ?? hour))
      return false;
    const last = s.lastStartedAt ? Date.parse(s.lastStartedAt) : NaN;
    return !Number.isFinite(last) || last + s.intervalHours * hour <= at;
  }
  private schedules() {
    return normalizeSchedules(
      this.deps.store.get("settings", "main")?.schedules,
    );
  }
  // Starts at most one due schedule per tick, only while the workspace is idle.
  async tick(): Promise<ScheduleKey | null> {
    if (
      this.ticking ||
      this.now() - this.createdAt < (this.deps.startDelayMs ?? 120_000)
    )
      return null;
    this.ticking = true;
    try {
      const schedules = this.schedules();
      for (const key of order) {
        if (!this.due(key, schedules)) continue;
        if (!this.deps.isIdle()) return null;
        const at = new Date(this.now()).toISOString();
        try {
          if (key === "careersScan") {
            await this.deps.prepareScan?.();
            if (!this.deps.isIdle() || !this.schedules()[key].enabled)
              return null;
            this.deps.scans.start("all", `schedule-${at}`);
          } else this.deps.validation.start();
        } catch (error: any) {
          this.failedAt.set(key, this.now());
          this.deps.store.journal(
            "schedule_error",
            `Scheduled ${key === "careersScan" ? "careers scan" : "availability check"} did not start: ${String(error?.message ?? error)}`,
            undefined,
            { schedule: key, retryAfterMs: this.deps.retryMs ?? hour },
          );
          this.deps.notify();
          continue;
        }
        this.failedAt.delete(key);
        this.record(key, at);
        this.deps.store.journal(
          "schedule_started",
          `Scheduled ${key === "careersScan" ? "careers scan of monitored companies" : "opening availability check"} started`,
          undefined,
          { schedule: key },
        );
        this.deps.notify();
        return key;
      }
      return null;
    } catch (error) {
      try {
        this.deps.store.journal(
          "schedule_error",
          `Scheduler tick failed: ${String(error)}`,
        );
      } catch {
        /* keep the service alive */
      }
      return null;
    } finally {
      this.ticking = false;
    }
  }
  private record(key: ScheduleKey, at: string) {
    const settings = this.deps.store.get("settings", "main") ?? {};
    const schedules = normalizeSchedules(settings.schedules);
    schedules[key].lastStartedAt = at;
    this.deps.store.put("settings", "main", {
      ...settings,
      schedules: withNextRuns(schedules, this.now()),
    });
    this.deps.store.autoExport();
  }
}
