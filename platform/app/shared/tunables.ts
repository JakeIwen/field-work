import { tunables } from "./tunables-registry.js";
export { tunables, tunableGroups } from "./tunables-registry.js";

export type TunableDefinition = {
  key: string;
  group: string;
  label: string;
  unit: "ms" | "s" | "min" | "days" | "count" | "chars" | "MiB";
  default: number;
  min: number;
  max: number;
  help: string;
  step?: number;
};
export type TunableKey = keyof typeof tunables;
/** Tunables have their own revision, like the palette and saved themes: a save
 * never bumps `settings.version`, which the pull forms use for conflicts and
 * which Greenhouse pacing bumps during a pull. */
export type TunableSettings = {
  tunables?: Partial<Record<TunableKey, number>>;
  tunablesRevision?: number;
};
export const tunablesPath = "/api/settings/tunables";
export type TunablesSave = {
  expectedRevision: number;
  values: Partial<Record<TunableKey, number | null>>;
};

/** Start of the 409 text for a stale revision; the client recognizes it. */
export const tunablesConflict = "Timing and limits changed elsewhere.";

export function tunablesRevision(settings: TunableSettings): number {
  return settings.tunablesRevision ?? 0;
}

/** Row label for a key, so errors name what the person sees on the page. */
export function tunableLabel(key: string): string {
  return Object.hasOwn(tunables, key) ? tunables[key as TunableKey].label : key;
}

/** Counts read naturally without a unit; every other unit is shown. */
export function unitSuffix(entry: Pick<TunableDefinition, "unit">): string {
  return entry.unit === "count" ? "" : ` ${entry.unit}`;
}

export function tunableProblem(key: string, value: unknown): string | null {
  if (!Object.hasOwn(tunables, key)) return `Unknown tunable "${key}".`;
  const entry: TunableDefinition = tunables[key as TunableKey];
  const { min, max, step } = entry;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (step === undefined
      ? !Number.isInteger(value)
      : Math.abs((value - min) / step - Math.round((value - min) / step)) >
        1e-8)
  )
    return `"${entry.label}" must be ${step === undefined ? "a whole number" : `a number in steps of ${step}`} from ${min} to ${max}${unitSuffix(entry)}.`;
  return null;
}

export function tunableValue(
  settings: TunableSettings,
  key: TunableKey,
): number {
  const value = settings.tunables?.[key];
  return tunableProblem(key, value) === null
    ? (value as number)
    : tunables[key].default;
}

type Term = readonly [TunableKey, number];
type Rule = {
  /** The sum of these (each scaled to milliseconds or plain counts) ... */
  left: readonly Term[];
  /** ... must be below, or no more than, this. */
  right: Term;
  strict?: boolean;
  message: (label: (key: TunableKey) => string) => string;
};

/** Relations between rows that a single row's bounds cannot express. */
const rules: readonly Rule[] = [
  {
    left: [["greenhouse.reviewCooldownInitialS", 1000]],
    right: ["greenhouse.reviewCooldownMaxMin", 60_000],
    message: (l) =>
      `${l("greenhouse.reviewCooldownMaxMin")} cannot be shorter than ${l("greenhouse.reviewCooldownInitialS")}.`,
  },
  {
    left: [["greenhouse.activityPerLane", 1]],
    right: ["greenhouse.activityPerRun", 1],
    message: (l) =>
      `${l("greenhouse.activityPerLane")} cannot exceed ${l("greenhouse.activityPerRun")}.`,
  },
  {
    left: [["records.exportQuietS", 1000]],
    right: ["records.exportDebounceCapS", 1000],
    message: (l) =>
      `${l("records.exportDebounceCapS")} cannot be shorter than ${l("records.exportQuietS")}.`,
  },
  {
    left: [["records.exportRetryFirstS", 1000]],
    right: ["records.exportRetryCapMin", 60_000],
    message: (l) =>
      `${l("records.exportRetryCapMin")} cannot be shorter than ${l("records.exportRetryFirstS")}.`,
  },
  {
    left: [["browser.reloadPollMs", 1]],
    right: ["browser.reloadPollCapS", 1000],
    message: (l) =>
      `${l("browser.reloadPollCapS")} cannot be shorter than ${l("browser.reloadPollMs")}.`,
  },
  {
    left: [
      ["careers.pageLoadWaitS", 1000],
      ["careers.networkSettleS", 1000],
      ["careers.captureDelayMs", 1],
    ],
    right: ["careers.browserRequestTimeoutS", 1000],
    strict: true,
    message: (l) =>
      `${l("careers.pageLoadWaitS")}, ${l("careers.networkSettleS")} and ${l("careers.captureDelayMs")} together must stay below ${l("careers.browserRequestTimeoutS")}.`,
  },
  {
    left: [["autofill.fetchRetryDelayMs", 1]],
    right: ["autofill.fetchMaxWaitS", 1000],
    message: (l) =>
      `${l("autofill.fetchRetryDelayMs")} cannot be longer than ${l("autofill.fetchMaxWaitS")}.`,
  },
  {
    left: [["gmail.overlapDays", 1]],
    right: ["gmail.lookbackDays", 1],
    message: (l) =>
      `${l("gmail.overlapDays")} cannot exceed ${l("gmail.lookbackDays")}.`,
  },
  {
    left: [
      ["documents.renderTimeoutS", 1000],
      ["documents.remoteRenderDeadlineAllowanceS", 1000],
    ],
    right: ["documents.remoteRenderDeadlineCeilingS", 1000],
    message: (l) =>
      `${l("documents.remoteRenderDeadlineCeilingS")} must be at least ${l("documents.renderTimeoutS")} plus ${l("documents.remoteRenderDeadlineAllowanceS")}.`,
  },
];

/** Validate the complete proposed overrides, not just the keys in a save patch. */
export function tunablesProblem(
  values: TunableSettings["tunables"],
): string | null {
  const settings = { tunables: values };
  const at = ([key, scale]: Term) => tunableValue(settings, key) * scale;
  for (const rule of rules) {
    const total = rule.left.reduce((sum, term) => sum + at(term), 0);
    const limit = at(rule.right);
    if (rule.strict ? total >= limit : total > limit)
      return rule.message(tunableLabel as (key: TunableKey) => string);
  }
  return null;
}
