export type ImportChanges = {
  added: number;
  updated: number;
  restored: number;
  missing: number;
};
export type RescanSummary = {
  companies: ImportChanges;
  openings: ImportChanges;
  documents: ImportChanges;
  sourceFilesChanged: number;
  incomplete: boolean;
};
export function rescanMessage(summary: RescanSummary) {
  const parts: string[] = [];
  for (const [key, singular, plural] of [
    ["openings", "opening", "openings"],
    ["companies", "company", "companies"],
    ["documents", "document", "documents"],
  ] as const) {
    for (const action of ["added", "updated", "restored", "missing"] as const) {
      const count = summary[key][action];
      if (count)
        parts.push(
          `${count} ${count === 1 ? singular : plural} ${action === "missing" ? "no longer in source files" : action}`,
        );
    }
  }
  const message = parts.length
    ? parts.join(", ") + "."
    : summary.sourceFilesChanged
      ? `${summary.sourceFilesChanged} source ${summary.sourceFilesChanged === 1 ? "file" : "files"} changed; no company, opening, or document changes.`
      : summary.incomplete
        ? "No changes imported from the files that could be read."
        : "No changes found.";
  return summary.incomplete ? `Rescan incomplete. ${message}` : message;
}
