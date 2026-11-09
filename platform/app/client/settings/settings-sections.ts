/** Section ids and index labels for the Settings page, declared once for the page and its index. */
export const settingsSections = [
  { id: "settings-codex-models", label: "Models" },
  { id: "settings-gmail", label: "Gmail" },
  { id: "settings-automatic-refresh", label: "Automatic refresh" },
  { id: "settings-generate-docs", label: "Generate Docs" },
  { id: "settings-greenhouse-pulls", label: "Greenhouse pulls" },
  { id: "settings-tunables", label: "Timing & limits" },
  { id: "settings-fit-criteria", label: "Scan fit criteria" },
  { id: "settings-appearance", label: "Appearance" },
  { id: "settings-workspace", label: "Workspace" },
  { id: "settings-records", label: "Records & activity" },
  { id: "settings-privacy", label: "Privacy & access" },
] as const;

export type SettingsSectionId = (typeof settingsSections)[number]["id"];
