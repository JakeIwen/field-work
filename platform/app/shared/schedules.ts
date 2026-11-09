// Automatic refresh schedules stored in settings.schedules.
export type ScheduleKey = "careersScan" | "openingValidation";
export type Schedule = {
  enabled: boolean;
  intervalHours: number; // 1..168
  lastStartedAt: string | null; // ISO, set by the scheduler when it starts a run
  nextRunAt: string | null; // ISO, derived by the server for display
};
export type Schedules = Record<ScheduleKey, Schedule>;
export const scheduleLabels: Record<
  ScheduleKey,
  { label: string; help: string }
> = {
  careersScan: {
    label: "Careers scan of monitored companies",
    help: "Runs the same tracked scan as the Careers scans page. Skipped while a scan, validation, or Codex turn is active.",
  },
  openingValidation: {
    label: "Opening availability check",
    help: "Rechecks whether retained postings are still open. Confirmed closures are hidden as usual.",
  },
};
export const defaultSchedules: Schedules = {
  careersScan: {
    enabled: false,
    intervalHours: 24,
    lastStartedAt: null,
    nextRunAt: null,
  },
  openingValidation: {
    enabled: false,
    intervalHours: 24,
    lastStartedAt: null,
    nextRunAt: null,
  },
};
export function normalizeSchedules(input: any): Schedules {
  const out = {} as Schedules;
  for (const key of Object.keys(defaultSchedules) as ScheduleKey[]) {
    const v = input?.[key] ?? {};
    const hours = Number(v.intervalHours);
    out[key] = {
      enabled: v.enabled === true,
      intervalHours: Number.isFinite(hours)
        ? Math.min(168, Math.max(1, Math.round(hours)))
        : defaultSchedules[key].intervalHours,
      lastStartedAt:
        typeof v.lastStartedAt === "string" ? v.lastStartedAt : null,
      nextRunAt: typeof v.nextRunAt === "string" ? v.nextRunAt : null,
    };
  }
  return out;
}
