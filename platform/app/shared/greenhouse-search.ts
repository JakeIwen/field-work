import { tunables } from "./tunables-registry.js";
// Search requests are lightweight, but must be paced independently of review work.
export const greenhouseDefaultPacingMs = 2000;
export const greenhouseDefaultPacingPenaltyMs = 0;
export const greenhousePacingIncreaseMs =
  tunables["greenhouse.pacingStepMs"].default;
// Require sustained successful capture before undoing one error's added delay.
export const greenhousePacingRecoveryPages =
  tunables["greenhouse.pacingRecoveryPages"].default;
export const greenhouseDriverIntervalBounds = {
  min: 1000,
  max: 60000,
} as const;
export type GreenhouseSearchTransport = "userscript" | "navigation";
export type GreenhousePacingIncrease = GreenhouseSearch & {
  at: string;
  page: number;
  error: string;
  from: number;
  to: number;
};

export type GreenhousePacingDecrease = Omit<GreenhousePacingIncrease, "error">;

export const greenhouseEmploymentTypeLabels = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  temporary: "Temporary",
} as const;

export type GreenhouseEmploymentType =
  keyof typeof greenhouseEmploymentTypeLabels;
export const regularGreenhouseEmploymentTypes = Object.keys(
  greenhouseEmploymentTypeLabels,
) as GreenhouseEmploymentType[];
export const focusedGreenhouseEmploymentTypes = [
  "contract",
  "part_time",
  "temporary",
] as const satisfies readonly GreenhouseEmploymentType[];
export const greenhouseEmploymentScopeOrder = [
  "full_time",
  ...focusedGreenhouseEmploymentTypes,
] as const satisfies readonly GreenhouseEmploymentType[];
export const defaultGreenhouseEmploymentScope: GreenhouseEmploymentType[] = [
  "full_time",
];
export const isDefaultGreenhouseEmploymentScope = (
  scope: readonly GreenhouseEmploymentType[] = defaultGreenhouseEmploymentScope,
) => scope.length === 1 && scope[0] === defaultGreenhouseEmploymentScope[0];

export type FocusedGreenhouseEmploymentType =
  (typeof focusedGreenhouseEmploymentTypes)[number];

export type GreenhouseSearch = {
  query: string;
  // Absent on historical cursors/pages: all four employment types.
  employmentTypes?: GreenhouseEmploymentType[];
};

export function greenhouseSearchIdentity(search: GreenhouseSearch) {
  const employmentTypes =
    search.employmentTypes ?? regularGreenhouseEmploymentTypes;
  const types = [...employmentTypes].sort();
  const regular =
    types.join() === [...regularGreenhouseEmploymentTypes].sort().join();
  return {
    // Search terms cannot contain control characters. Preserve legacy plain-text
    // provenance without colliding with a custom term that resembles a label.
    key: regular ? search.query : `${search.query}\u001f${types.join(",")}`,
    label: regular
      ? search.query
      : `${search.query} · ${types.map((type) => greenhouseEmploymentTypeLabels[type]).join(", ")}`,
    employmentTypes,
  };
}
