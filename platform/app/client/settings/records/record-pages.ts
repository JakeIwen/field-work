import type { CatalogKind, CatalogPage } from "../../../shared/record-catalog";
import type { ActivityPage } from "../../../shared/activity";

export const catalogLabels: Record<CatalogKind, string> = {
  application: "Application",
  application_autofill: "Autofill script",
  application_preparation: "Generate Docs run",
  career_scan: "Careers scan",
  company: "Company",
  document: "Document",
  greenhouse_pull_run: "Greenhouse pull",
  opening: "Opening",
  opening_validation_run: "Availability check",
  task: "Agent task",
};

export function recordSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function appendCatalog(previous: CatalogPage, next: CatalogPage): CatalogPage {
  const keys = new Set(previous.rows.map(row => `${row.kind}:${row.id}`));
  return { ...next, rows: [...previous.rows, ...next.rows.filter(row => !keys.has(`${row.kind}:${row.id}`))] };
}

export function appendActivity(previous: ActivityPage, next: ActivityPage): ActivityPage {
  const ids = new Set(previous.entries.map(entry => entry.id));
  return { ...next, entries: [...previous.entries, ...next.entries.filter(entry => !ids.has(entry.id))] };
}
