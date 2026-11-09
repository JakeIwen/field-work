import type { ActivityLevel } from "../shared/activity.js";

type JournalPresentation = {
  workflow: string;
  level: ActivityLevel | { sql: string };
};
const outcome = `lower(COALESCE(json_extract(json,'$.message'),'') || ' ' || COALESCE(json_extract(json,'$.details.outcome'),''))`;
const schedule = `CASE json_extract(json,'$.details.schedule') WHEN 'careersScan' THEN 'Careers scan' WHEN 'openingValidation' THEN 'Availability check' ELSE 'Scheduler' END`;

/** Every current writer and the retained historical types share this one classification table. */
export const journalTypePresentation: Record<string, JournalPresentation> = {
  "application-autofill": { workflow: "Greenhouse autofill", level: "info" },
  autofill_fetch: {
    workflow: "Greenhouse autofill",
    level: {
      sql: `CASE WHEN ${outcome} LIKE '%fail%' THEN 'error' WHEN ${outcome} LIKE '%retry%' THEN 'warning' ELSE 'info' END`,
    },
  },
  application_preparation: { workflow: "Generate Docs", level: "info" },
  application_preparation_ready: { workflow: "Generate Docs", level: "info" },
  application_documents_generated: { workflow: "Generate Docs", level: "info" },
  application_document_error: { workflow: "Generate Docs", level: "error" },
  document_retention: { workflow: "Generate Docs", level: "info" },
  document_retention_failed: { workflow: "Generate Docs", level: "warning" },
  validation: {
    workflow: "Agent task",
    level: {
      sql: `CASE WHEN ${outcome} LIKE '%fail%' OR ${outcome} LIKE '%invalid%' THEN 'warning' ELSE 'info' END`,
    },
  },
  task_created: { workflow: "Agent task", level: "info" },
  task_artifacts: { workflow: "Agent task", level: "info" },
  resume_promoted: { workflow: "Resume revision", level: "info" },
  promotion_failed: { workflow: "Resume revision", level: "error" },
  files_reindexed: {
    workflow: "File import",
    level: {
      sql: `CASE WHEN json_type(json,'$.details.summary.incomplete')='true' THEN 'warning' ELSE 'info' END`,
    },
  },
  source_changed: { workflow: "File import", level: "info" },
  watcher_error: { workflow: "File import", level: "error" },
  import_error: { workflow: "File import", level: "error" },
  careers_scan_started: { workflow: "Careers scan", level: "info" },
  careers_scan_completed: {
    workflow: "Careers scan",
    level: {
      sql: `CASE WHEN COALESCE(json_extract(json,'$.details.failed'),0)>0 THEN 'warning' ELSE 'info' END`,
    },
  },
  openings_validated: { workflow: "Availability check", level: "info" },
  gmail_application_updated: { workflow: "Gmail", level: "info" },
  app_reload: { workflow: "App reload", level: "info" },
  application_created: { workflow: "Applications", level: "info" },
  application_updated: { workflow: "Applications", level: "info" },
  application_started: { workflow: "Applications", level: "info" },
  application_submitted: { workflow: "Applications", level: "info" },
  follow_up_drafted: { workflow: "Follow-up email", level: "info" },
  follow_up_sent: { workflow: "Follow-up email", level: "info" },
  document_preferred: { workflow: "Documents", level: "info" },
  opening_added: { workflow: "Opening research", level: "info" },
  opening_merged: { workflow: "Opening research", level: "info" },
  opening_import_matched: { workflow: "Opening research", level: "info" },
  personal_updated: { workflow: "Saved records", level: "info" },
  company_added: { workflow: "Companies", level: "info" },
  opening_dismissal_migration: { workflow: "Maintenance", level: "info" },
  greenhouse_review_memory_backfill: {
    workflow: "Greenhouse pull",
    level: "info",
  },
  schedule_started: { workflow: schedule, level: "info" },
  schedule_error: { workflow: schedule, level: "error" },
};

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
export const journalWorkflowSql = `CASE json_extract(json,'$.type') ${Object.entries(
  journalTypePresentation,
)
  .map(
    ([type, row]) =>
      `WHEN ${quote(type)} THEN ${row.workflow === schedule ? schedule : quote(row.workflow)}`,
  )
  .join(" ")} ELSE 'Activity' END`;
export const journalLevelSql = `CASE json_extract(json,'$.type') ${Object.entries(
  journalTypePresentation,
)
  .map(
    ([type, row]) =>
      `WHEN ${quote(type)} THEN ${typeof row.level === "string" ? quote(row.level) : row.level.sql}`,
  )
  .join(" ")} ELSE 'info' END`;
