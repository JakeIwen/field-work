export type RescanProgress = {
  phase:
    | "research"
    | "discovery"
    | "documents"
    | "references"
    | "history"
    | "snapshots"
    | "reconcile"
    | "saving";
  completed?: number;
  total?: number;
};
export function rescanProgressLabel(progress: RescanProgress) {
  const labels = {
    research: "Reading companies and openings",
    discovery: "Finding documents",
    documents: "Reading documents",
    references: "Checking document references",
    history: "Reading research history",
    snapshots: "Reading research snapshots",
    reconcile: "Reconciling research",
    saving: "Updating local index",
  };
  return (
    labels[progress.phase] +
    (progress.total !== undefined
      ? ` · ${progress.completed ?? 0}/${progress.total}`
      : "…")
  );
}
