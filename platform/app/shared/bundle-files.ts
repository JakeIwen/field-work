export type BundleArtifact = { path: string; hash?: string; format?: string };

export function documentKind(file: string): "resume" | "cover-letter" | null {
  const name = file.split("/").at(-1) || "";
  if (/cover[_ -]?letter/i.test(name)) return "cover-letter";
  if (/resume/i.test(name)) return "resume";
  return null;
}

export const artifactGroups = [
  { id: "documents", title: "Generated PDFs", expanded: true },
  { id: "changes", title: "Document sources and changes", expanded: true },
  { id: "references", title: "Unchanged reference copies", expanded: false },
  {
    id: "task",
    title: "Task instructions and supporting files",
    expanded: false,
  },
  { id: "validation", title: "Validation reports", expanded: false },
  { id: "history", title: "Saved revisions", expanded: false },
] as const;

// These labels describe provenance inside the isolated task, not the status of
// the original repository file or whether a document has passed validation.
export function artifactInfo(
  item: BundleArtifact | string,
  sourceHashes: Record<string, string> = {},
) {
  const file = typeof item === "string" ? item : item.path;
  const hash = typeof item === "string" ? undefined : item.hash;
  const name = file.split("/").at(-1) || "";
  if (/(^|\/)(revisions|history|backups)(\/|$)/i.test(file))
    return { group: "history", label: "Saved revision" };
  if (/(^|\/)validation(\/|$)/i.test(file))
    return { group: "validation", label: "Report" };
  if (
    name === "AGENTS.md" ||
    name === "context-manifest.json" ||
    /-INSTRUCTIONS\.md$/.test(name) ||
    file.startsWith(".agent/")
  )
    return { group: "task", label: "Task instructions" };
  const original = sourceHashes[file];
  if (hash && original === hash)
    return { group: "references", label: "Unchanged copy" };
  if (!hash) return { group: "task", label: "Not compared" };
  if (/\.pdf$/i.test(file))
    return { group: "documents", label: original ? "Updated PDF" : "New PDF" };
  if (original || documentKind(file))
    return {
      group: "changes",
      label: original ? "Modified copy" : "New source",
    };
  return { group: "task", label: "Task file" };
}
