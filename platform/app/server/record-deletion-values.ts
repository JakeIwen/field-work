import type { Records } from "./records.js";

export type DeletionRow = { kind: keyof Records; id: string; value: any };
export const deletionRowKey = (row: Pick<DeletionRow, "kind" | "id">) =>
  `${row.kind}:${row.id}`;
export const deletionRowTitle = (row: DeletionRow) =>
  String(
    row.value.title || row.value.name || row.value.message || row.id,
  ).slice(0, 200);
