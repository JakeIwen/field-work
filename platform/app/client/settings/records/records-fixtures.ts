import type { CatalogPage, CatalogRow, RecordDetail } from "../../../shared/record-catalog";
import type { ActivityEntry, ActivityPage } from "../../../shared/activity";

export const applicationRow: CatalogRow = { kind: "application", id: "app / fixture", title: "Example · Software engineer",
  subtitle: "Application for Example", status: "applied", at: "2026-10-30T01:02:00Z", atLabel: "Created", bytes: 2048 };
export const taskRow: CatalogRow = { kind: "task", id: "task-fixture", title: "Prepare Example documents", status: "completed", bytes: 512 };
export const catalogPage: CatalogPage = { rows: [applicationRow], total: 2, counts: { application: 1, task: 1 }, nextCursor: "next / record" };
export const activityEntry: ActivityEntry = { id: "entry-one", at: "2026-10-30T01:02:00Z", type: "preparation_warning",
  workflow: "Generate Docs", level: "warning", message: "Resume needs attention", entity: { kind: "application", id: applicationRow.id, title: applicationRow.title },
  details: '{"reason":"Evidence changed"}' };
export const activityError: ActivityEntry = { ...activityEntry, id: "entry-two", level: "error", message: "Rendering stopped", detailsTruncated: true };
export const activityPage: ActivityPage = { entries: [activityEntry, activityError], total: 3,
  counts: { workflow: { "Generate Docs": 2, "File import": 1 }, level: { info: 1, warning: 1, error: 1 } }, nextCursor: "older / activity" };
export const recordDetail: RecordDetail = { row: applicationRow, fields: [{ label: "Status", value: "Applied on October 29" }],
  related: [{ kind: "opening", id: "opening / fixture", title: "Example opening" }, { kind: "application_preparation", id: "preparation", title: "Original preparation" }],
  relatedTotal: 2, activity: [activityEntry], raw: '{"id":"app / fixture","notes":"Private notes"}', rawTruncated: true };
