export const preparationDefaultParallelRuns = 8;
export const preparationParallelRunBounds = { min: 1, max: 12 } as const;
export const preparationSettingsPath = "/api/settings/preparation";

export type PreparationSettings = {
  parallelPreparations?: number;
};

export type PreparationSettingsSave = {
  expectedVersion: number;
  parallelPreparations: number;
};
