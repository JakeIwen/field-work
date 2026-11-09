
export const stageNames = [
  "considering",
  "preparing",
  "ready",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];
export const stageLabel = (s: string) =>
  s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
