export const deletionKinds = [
  "company",
  "opening",
  "application",
  "document",
  "task",
  "application_autofill",
  "application_preparation",
  "career_scan",
  "opening_validation_run",
  "greenhouse_pull_run",
  "filter",
  "journal",
] as const;
export type DeletionKind = (typeof deletionKinds)[number];
export type DeletionPreview = {
  token: string;
  title: string;
  records: { kind: string; id: string; title: string }[];
  updatedRecords: { kind: string; id: string; title: string }[];
  files: string[];
  editedFiles: string[];
  sharedFiles: number;
  /** Work that must finish first; Delete stays disabled while it runs. */
  blockedBy?: string[];
};
