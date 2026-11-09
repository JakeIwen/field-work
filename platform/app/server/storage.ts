import { tunable } from "./tunables.js";
import { migrateTaskEvents } from "./storage-task-event-migration.js";
import {
  createTaskEventStorage,
  readTaskEvents,
  readTaskSelectionEvents,
  appendTaskEvent,
  taskWithoutEmbeddedEvents,
  type TaskEventRead,
} from "./storage-task-events.js";
import { initializePersonalExportChanges } from "./storage-export-dirty.js";
import { personalExportSnapshot } from "./storage-export-snapshot.js";
import { taskThreadIds } from "../shared/task-threads.js";
import {
  schedulePersonalExport,
  reschedulePersonalExport,
  flushPersonalExport,
  closePersonalExport,
} from "./storage-export.js";
import { FIELDWORK_TIMEZONE } from "../shared/timezone.js";
import { createBackupArchive } from "./backup-archive.js";
import { clearReadCache } from "./storage-read-cache.js";
import { readOpenings, openingRecordKinds } from "./storage-openings.js";
import {
  cachedStateRead,
  initializeStateCache,
  invalidateStateCache,
} from "./storage-state-cache.js";
import { readState } from "./storage-state.js";
import { migrateOpeningDismissals } from "./storage-migrations.js";
import { normalizeGeneratedDocument } from "./document-names.js";
import { summarizeImport } from "./import-summary.js";
import { rescanMessage } from "../shared/rescan-summary.js";
import { importCompanyContacts } from "./company-contacts.js";
import { withNextRuns } from "./scheduler.js";
import { normalizeFitCriteria } from "../shared/fit-criteria.js";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Records, VersionedKind } from "./records.js";
import type { Task, TaskSummary, TaskEvent } from "../shared/task-records.js";
import type { Opening } from "../shared/types.js";
import type { ImportResult, Document, AppState } from "../shared/types.js";

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class MissingRecordError extends HttpError {
  constructor(
    status: 404 | 409,
    public kind: string,
    public id: string,
    message: string,
  ) {
    super(status, message);
  }
}
export const now = () => new Date().toISOString();
const allowedRoots = [
  "source_data",
  "source_master_template",
  "employer_specific",
  "old_resume",
  "company_careers",
];
export function safeSource(root: string, relative: string): string {
  root = realpathSync(root);
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  )
    throw new HttpError(400, "Invalid repository-relative path");
  const first = relative.split("/")[0];
  const rootDocument = ["AGENTS.md", "README.md"].includes(relative);
  if (!allowedRoots.includes(first) && !rootDocument)
    throw new HttpError(403, "Path is outside configured document roots");
  if (
    /SIGNED|offer.letter|\.zip$/i.test(relative) ||
    (/\.docx$/i.test(relative) && first !== "old_resume")
  )
    throw new HttpError(
      403,
      "Sensitive evidence is not available through document routes",
    );
  const full = path.resolve(root, relative);
  let resolved: string;
  try {
    resolved = realpathSync(full);
  } catch {
    throw new HttpError(404, "Source file is missing");
  }
  const allowed = rootDocument ? full : path.resolve(root, first) + path.sep;
  if (rootDocument ? resolved !== full : !resolved.startsWith(allowed))
    throw new HttpError(403, "Symlink leaves its configured source root");
  if (!lstatSync(resolved).isFile())
    throw new HttpError(400, "Source must be a regular file");
  return resolved;
}
export function atomicWrite(
  file: string,
  value: string | Uint8Array | Iterable<string>,
) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink())
    throw new HttpError(409, "Refusing to replace a symlink");
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      if (typeof value === "string" || value instanceof Uint8Array)
        writeFileSync(fd, value);
      else for (const chunk of value) writeFileSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    // A failed iterator or write must retain the previous complete export, not a partial file.
    rmSync(temp, { force: true });
  }
}
export class Store {
  db: DatabaseSync;
  private taskThreads?: Map<string, string>;
  private readOnly = false;
  constructor(
    public root: string,
    public dataDir: string,
    options: { readOnly?: boolean } = {},
  ) {
    this.root = realpathSync(root);
    if (options.readOnly) {
      this.readOnly = true;
      this.dataDir = realpathSync(dataDir);
      this.db = new DatabaseSync(path.join(this.dataDir, "workspace.sqlite"), {
        readOnly: true,
      });
      initializeStateCache(this, true);
      return;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(dataDir);
    mkdirSync(path.join(dataDir, "objects"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
      INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(1,datetime('now'));`);
    createTaskEventStorage(this.db);
    initializeStateCache(this);
    initializePersonalExportChanges(this);
    let migrated: boolean;
    try {
      const eventsMigrated = migrateTaskEvents(this);
      migrated = migrateOpeningDismissals(this) || eventsMigrated;
    } catch (error) {
      this.db.close();
      throw error;
    }
    let renamed = false;
    for (const doc of this.list("generated_document")) {
      const normalized = normalizeGeneratedDocument(doc);
      if (
        normalized.name !== doc.name ||
        normalized.postingLabel !== doc.postingLabel ||
        normalized.version !== doc.version
      ) {
        this.put("generated_document", doc.id, normalized);
        renamed = true;
      }
    }
    if (renamed || migrated) this.autoExport();
    if (!this.get("settings", "main"))
      this.put("settings", "main", {
        timezone: FIELDWORK_TIMEZONE,
        version: 1,
      });
  }
  // Settings with defaults filled, so clients always receive schedules and fitCriteria.
  settings() {
    const raw = this.get("settings", "main") ?? {
      timezone: FIELDWORK_TIMEZONE,
      version: 1,
    };
    return {
      ...raw,
      schedules: withNextRuns(raw.schedules),
      fitCriteria: normalizeFitCriteria(raw.fitCriteria),
    };
  }
  // The constructor always initializes the singleton settings record before callers can read it.
  get(kind: "settings", id: "main"): Records["settings"];
  get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined;
  get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined {
    const r = this.db
      .prepare("SELECT json FROM records WHERE kind=? AND id=?")
      // The query selects only the JSON text column from records.
      .get(kind, id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }
  taskForThread(threadId: string | null | undefined): Task | undefined {
    if (!threadId) return undefined;
    if (!this.taskThreads) {
      // This projection contains only the record ID and its optional persisted thread ID.
      const rows = this.db
        .prepare(
          `SELECT id, json_extract(json, '$.threadId') AS threadId FROM records WHERE kind='task'
           UNION SELECT records.id, history.value AS threadId FROM records, json_each(records.json, '$.previousThreadIds') AS history WHERE kind='task'`,
        )
        .all() as { id: string; threadId: string | null }[];
      this.taskThreads = new Map(
        rows.filter((r) => r.threadId).map((r) => [r.threadId!, r.id]),
      );
    }
    const id = this.taskThreads.get(threadId);
    const task = id ? this.get("task", id) : undefined;
    return task && taskThreadIds(task).includes(threadId) ? task : undefined;
  }
  taskSummaries(id?: string, openingId?: string): TaskSummary[] {
    // Event payloads live outside records; drop the remaining detail-only fields.
    // SQLite returns JSON text plus a nullable count; its generic row type cannot express this projection.
    const rows = this.db
      .prepare(
        `SELECT json_remove(json, '$.eventCount', ${this.readOnly ? "'$.events', " : ""}'$.thread', '$.autofillContext.profileSnapshot', '$.greenhousePull.candidate') AS json,
      ${this.readOnly ? "COALESCE(json_extract(json, '$.eventCount'),json_array_length(json, '$.events'))" : "json_extract(json, '$.eventCount')"} AS eventCount FROM records WHERE kind='task'${id === undefined ? "" : " AND id=?"}${openingId === undefined ? "" : " AND json_extract(json, '$.context.openingId')=?"} ORDER BY rowid`,
      )
      .all(
        ...(id === undefined ? [] : [id]),
        ...(openingId === undefined ? [] : [openingId]),
      ) as {
      json: string;
      eventCount: number | null;
    }[];
    return rows.map((r) => ({
      ...JSON.parse(r.json),
      eventCount: Math.min(r.eventCount ?? 0, 500),
    }));
  }
  taskEvents(id: string, options?: TaskEventRead) {
    return readTaskEvents(this.db, id, options);
  }
  taskSelectionEvents(id: string) {
    return readTaskSelectionEvents(this.db, id);
  }
  appendTaskEvent(id: string, event: TaskEvent, at: string, count: number) {
    return appendTaskEvent(
      this.db,
      id,
      event,
      at,
      count,
      tunable(this, "models.taskEventCap"),
    );
  }
  taskForClientRequest(clientRequestId: string): Task | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM records WHERE kind='task' AND json_extract(json,'$.clientRequestId')=? ORDER BY rowid LIMIT 1",
      )
      .get(clientRequestId);
    return row ? JSON.parse(String(row.json)) : undefined;
  }
  /** Newest preparation run of an Opening: a filtered read for polling, not a parse of every run. */
  latestPreparationForOpening(
    openingId: string,
  ): Records["application_preparation"] | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM records WHERE kind='application_preparation' AND json_extract(json,'$.openingId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(openingId);
    return row ? JSON.parse(String(row.json)) : undefined;
  }
  document(id: string): Document | undefined {
    return this.get("cache_document", id) ?? this.get("generated_document", id);
  }
  opening(id: string): Opening | undefined {
    if (typeof id !== "string" || !id) return undefined;
    return (
      this.openings().find((o) => o.id === id) ?? this.get("cache_opening", id)
    );
  }
  openings(): Opening[] {
    return cachedStateRead(this, "openings", openingRecordKinds, () =>
      readOpenings(this),
    );
  }
  list<K extends keyof Records>(kind: K): Records[K][] {
    return (
      (
        this.db
          .prepare("SELECT json FROM records WHERE kind=? ORDER BY rowid")
          // The query selects only the JSON text column from records.
          .all(kind) as { json: string }[]
      ).map((r) => JSON.parse(r.json))
    );
  }
  put<K extends keyof Records>(
    kind: K,
    id: string,
    value: Records[K],
  ): Records[K] {
    clearReadCache(this);
    if (kind !== "deleted_record" && this.isDeleted(kind, id))
      throw new HttpError(410, "This record was permanently deleted.");
    if (kind === "task") {
      // Legacy imports replace event rows atomically with their metadata, including outside an outer transaction.
      if (!this.db.isTransaction)
        return this.transaction(() => this.put(kind, id, value));
      value = taskWithoutEmbeddedEvents(
        this.db,
        id,
        value as Task,
      ) as Records[K];
    }
    this.db
      .prepare(
        "INSERT INTO records(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",
      )
      .run(kind, id, JSON.stringify(value));
    // The task key guarantees a Task payload; TypeScript cannot narrow generic indexed values.
    if (kind === "task" && this.taskThreads) {
      const ids = taskThreadIds(value as Task);
      for (const [threadId, taskId] of this.taskThreads)
        if (taskId === id && !ids.includes(threadId))
          this.taskThreads.delete(threadId);
      for (const threadId of ids) this.taskThreads.set(threadId, id);
    }
    return value;
  }
  remove(kind: keyof Records, id: string) {
    clearReadCache(this);
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
    if (kind === "task") this.taskThreads = undefined;
  }
  isDeleted(kind: keyof Records, id: string) {
    const peers = ["cache_company", "custom_company"].includes(kind)
      ? ["cache_company", "custom_company"]
      : ["cache_opening", "custom_opening"].includes(kind)
        ? ["cache_opening", "custom_opening"]
        : ["cache_document", "generated_document"].includes(kind)
          ? ["cache_document", "generated_document"]
          : [kind];
    return peers.some(
      (k) => !!this.get("deleted_record", sha256(`${k}:${id}`)),
    );
  }
  transaction<T>(fn: () => T): T {
    clearReadCache(this);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } finally {
        // A projection may have observed writes that the transaction did not keep.
        invalidateStateCache(this);
        this.taskThreads = undefined;
      }
      throw e;
    }
  }
  update<K extends VersionedKind>(
    kind: K,
    id: string,
    expectedVersion: number,
    patch: Partial<Records[K]>,
    // The historical empty initial value is completed by the patch; preserve that update contract.
    initial: Records[K] = {} as Records[K],
  ) {
    return this.transaction(() => {
      const old = this.get(kind, id) ?? { ...initial, version: 0 };
      if (old.version !== expectedVersion)
        throw new HttpError(
          409,
          "This record changed in another window. Reload before saving; your draft remains in this form.",
        );
      return this.put(kind, id, {
        ...old,
        ...patch,
        id,
        version: old.version + 1,
        updatedAt: now(),
      });
    });
  }
  journal(type: string, message: string, entityId?: string, details?: unknown) {
    const e = { id: randomUUID(), at: now(), type, message, entityId, details };
    this.put("journal", e.id, e);
    return e;
  }
  capture(doc: Document) {
    const dest = this.objectPath(doc.hash);
    if (!existsSync(dest)) {
      const data = readFileSync(safeSource(this.root, doc.path));
      if (sha256(data) !== doc.hash)
        throw new HttpError(409, `Source changed during import: ${doc.path}`);
      atomicWrite(dest, data);
    }
  }
  objectPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new HttpError(400, "Invalid content hash");
    // Check the canonical anchor and directory too, not only the object leaf.
    const objects = path.join(this.dataDir, "objects");
    for (const directory of [this.dataDir, objects]) {
      let stat;
      try {
        stat = lstatSync(directory);
      } catch {
        throw new HttpError(409, "Object storage directory is missing");
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        realpathSync(directory) !== directory
      )
        throw new HttpError(403, "Object storage cannot traverse a symlink");
    }
    const p = path.join(objects, hash);
    try {
      const stat = lstatSync(p);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new HttpError(
          403,
          "Object must be a regular file, never a symlink",
        );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return p;
  }
  import(result: ImportResult) {
    const snapshot = () => ({
      companies: [
        ...this.list("cache_company"),
        ...this.list("custom_company"),
      ],
      openings: this.openings(),
      documents: this.list("cache_document"),
      sourceHashes: this.get("meta", "import")?.sourceHashes ?? {},
    });
    const before = snapshot();
    const captureErrors: any[] = [];
    const validDocs: Document[] = [];
    const failedPaths = new Set<string>();
    // A partially unreadable tree can still supply valid additions. Missing files are
    // reconciled only after a complete tree read, and a racing edit never supersedes
    // the last successfully captured version at that path.
    result.companies = result.companies.filter(
      (c) => !this.get("deleted_record", sha256(`cache_company:${c.id}`)),
    );
    result.openings = result.openings.filter(
      (o) =>
        !this.get("deleted_record", sha256(`cache_opening:${o.id}`)) &&
        !this.get("deleted_record", sha256(`cache_company:${o.company_id}`)),
    );
    result.documents = result.documents.filter(
      (d) => !this.get("deleted_record", sha256(`cache_document:${d.id}`)),
    );
    for (const doc of result.documents) {
      try {
        const bytes = readFileSync(safeSource(this.root, doc.path));
        if (sha256(bytes) !== doc.hash)
          throw new HttpError(409, `Source changed during import: ${doc.path}`);
        this.capture(doc);
        validDocs.push(doc);
      } catch (e) {
        failedPaths.add(doc.path);
        captureErrors.push({
          id: `capture:${doc.id}`,
          severity: "error",
          category: "import",
          message: String(e),
          paths: [doc.path],
        });
      }
    }
    this.transaction(() => {
      for (const [section, kind] of [
        ["companies", "cache_company"],
        ["openings", "cache_opening"],
      ] as const) {
        if (!result.validSections[section]) continue;
        const ids = new Set(result[section].map((x) => x.id));
        for (const old of this.list(kind))
          if (!ids.has(old.id))
            this.put(kind, old.id, {
              ...old,
              ...(section === "openings"
                ? {
                    // The openings section selects Opening rows; generic tuple correlation is not retained here.
                    postingStatus:
                      (old as Opening).postingStatus === "closed"
                        ? "closed"
                        : "not confirmed open",
                    retained: false,
                  }
                : { sourceMissing: true }),
              lastAbsentFromSourceAt: result.importedAt,
            });
        for (const row of result[section]) {
          const old = this.get(kind, row.id);
          if (section === "companies" && !this.get("personal", row.id)) {
            const pending =
              !old && !!this.get("meta", "import")?.validSections?.companies;
            this.put("personal", row.id, {
              id: row.id,
              version: 0,
              monitoring: !pending,
              pendingWatchlist: pending,
            });
          }
          if (old && old.hash !== row.hash)
            this.journal(
              "source_changed",
              `${section === "companies" ? "Company research" : "Opening assessment"} changed`,
              row.id,
              {
                previousHash: old.hash,
                hash: row.hash,
                sourceDate: row.sourceDate,
              },
            );
          this.put(kind, row.id, {
            ...row,
            retained: section === "openings" ? row.retained !== false : true,
            sourceMissing: false,
            firstImportedAt: old?.firstImportedAt ?? result.importedAt,
          });
        }
      }
      const ids = new Set(validDocs.map((d) => d.id));
      const capturedPaths = new Set(validDocs.map((d) => d.path));
      for (const old of this.list("cache_document")) {
        if (
          !ids.has(old.id) &&
          !failedPaths.has(old.path) &&
          (result.validSections.documents || capturedPaths.has(old.path))
        )
          this.put("cache_document", old.id, {
            ...old,
            availableInSource: false,
            status: old.status === "current" ? "superseded" : old.status,
          });
      }
      for (const doc of validDocs) {
        const old = this.get("cache_document", doc.id);
        this.put("cache_document", doc.id, {
          ...doc,
          availableInSource: true,
          immutableCopyAvailable: true,
          sourceVerifiedAt: result.importedAt,
          firstImportedAt: old?.firstImportedAt ?? result.importedAt,
        });
      }
      for (const doc of result.documents)
        if (
          failedPaths.has(doc.path) &&
          !this.get("cache_document", doc.id) &&
          !this.list("cache_document").some((old) => old.path === doc.path)
        )
          this.put("cache_document", doc.id, {
            ...doc,
            availableInSource: false,
            immutableCopyAvailable: false,
            firstImportedAt: result.importedAt,
          });
      const old = this.get("meta", "import");
      const preserveScan = result.scan.stateValid === false && !!old?.scan;
      const scan = preserveScan
        ? {
            ...old.scan,
            stateValid: false,
            previousStatePreserved: true,
            importAttemptAt: result.importedAt,
          }
        : result.scan;
      if (!scan.history && old?.scan?.history) scan.history = old.scan.history;
      const priorScanHealth = preserveScan
        ? (old.health ?? []).filter((h: any) =>
            ["inaccessible-employer", "stale-scan"].includes(h.category),
          )
        : [];
      const health = [...result.health, ...priorScanHealth, ...captureErrors];
      const sourceHashes = {
        ...(old?.sourceHashes ?? {}),
        ...result.sourceHashes,
      };
      this.put("meta", "import", {
        ...result,
        scan,
        sourceHashes,
        companies: [],
        openings: [],
        documents: [],
        health: [...new Map(health.map((h) => [h.id, h])).values()],
        previousImportedAt: old?.importedAt,
      });
    });
    importCompanyContacts(this);
    const imported = this.get("meta", "import");
    if (!imported)
      throw new MissingRecordError(
        409,
        "meta",
        "import",
        "Import metadata was not saved. Retry the rescan.",
      );
    const summary = summarizeImport(
      before,
      snapshot(),
      Object.values(result.validSections).some((valid) => !valid) ||
        captureErrors.length > 0 ||
        result.health.some((h) => h.severity === "error"),
    );
    if (
      summary.sourceFilesChanged ||
      [summary.companies, summary.openings, summary.documents].some((c) =>
        Object.values(c).some(Boolean),
      ) ||
      summary.incomplete
    )
      this.journal(
        "files_reindexed",
        `Local files reindexed. ${rescanMessage(summary)}`,
        undefined,
        { validSections: result.validSections, summary },
      );
    this.autoExport();
    return summary;
  }
  state(): AppState {
    return readState(this);
  }
  personalExport() {
    return personalExportSnapshot(this);
  }
  autoExport() {
    schedulePersonalExport(this);
  }
  rescheduleExport() {
    reschedulePersonalExport(this);
  }
  flushExport() {
    flushPersonalExport(this);
  }
  backup(): Uint8Array {
    return createBackupArchive(this).bytes;
  }
  close() {
    try {
      closePersonalExport(this);
    } finally {
      this.db.close();
    }
  }
}
