import { tunable } from "./tunables.js";
import { tunables } from "../shared/tunables.js";
import { putTaskWithEvents } from "./storage-task-events.js";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { preparationBusy } from "../shared/application-preparation.js";
import { isTaskBusy, type Document } from "../shared/types.js";
import { referencedBackupObjects } from "./backup-integrity.js";
import { ownedPath } from "./record-deletion.js";
import type { Records } from "./records.js";
import { atomicWrite, now, sha256, type Store } from "./storage.js";

/** Owner decision (2026-10-19): keep the two newest generated PDFs per Opening, kind and privacy. */
export const RETAINED_DOCUMENT_VERSIONS =
  tunables["documents.retainedVersions"].default;

type Kind = keyof Records;
type Row = { kind: Kind; id: string; value: any };
type Plan = NonNullable<ReturnType<typeof planRetention>>;
type FileEdit = { file: string; before: Buffer };
export type DocumentRetentionPreview = {
  documents: {
    id: string;
    name: string;
    kind: string;
    privacy: string;
    owner: string;
    createdAt?: string;
  }[];
  scripts: string[];
  tasks: string[];
  files: string[];
  updatedRecords: number;
};

const tailored = (doc: Document) =>
  doc.scope === "tailored" && doc.origin === "generated";
/** The retention group's owner; early tailored documents predate openingId and name only their posting. */
export const documentRetentionOwner = (doc: Document) =>
  doc.openingId || doc.postingUrl || doc.postingLabel || "";
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];
// Record ids and content hashes as they appear inside stored JSON strings.
const referenceTokens =
  /generated-[^"\\]+|[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function load(store: Store, kinds: Kind[]): Row[] {
  // Planning needs task status and references, not conversation transcripts.
  return (
    store.db
      .prepare(
        `SELECT kind,id,CASE kind WHEN 'task' THEN json_remove(json,'$.thread') ELSE json END AS json
        FROM records WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY rowid`,
      )
      .all(...kinds) as { kind: Kind; id: string; json: string }[]
  ).map((r) => ({ kind: r.kind, id: r.id, value: JSON.parse(r.json) }));
}

/**
 * Everything a retained record still needs. Applications and their sent
 * packages are immutable, the current preparation and script per Opening keep
 * their files whatever their age, and running work is never edited.
 */
function protectedValues(all: Row[]) {
  const values = new Set<string>();
  const keep = (value: unknown) => strings(value).forEach((s) => values.add(s));
  const latest = (kind: Kind) => {
    const runs = new Map<string, Row>();
    for (const r of all) if (r.kind === kind) runs.set(r.value.openingId, r);
    return [...runs.values()];
  };
  const packagedScripts = new Set<string>();
  for (const r of all) {
    const v = r.value;
    if (r.kind === "application") {
      keep(v);
      for (const pack of v.packages ?? [])
        if (pack.scriptId) packagedScripts.add(pack.scriptId);
    }
    if (r.kind === "generated_document" && v.usedInApplications?.length)
      keep(r.id);
    if (r.kind === "application_preparation" && preparationBusy(v)) keep(v);
    if (r.kind === "task" && isTaskBusy(v.status)) {
      keep(v);
      keep(all.find((b) => b.kind === "bundle" && b.id === r.id)?.value);
    }
  }
  for (const r of latest("application_preparation"))
    keep([r.value.documentIds, r.value.taskIds, r.value.answerTaskId]);
  const currentScripts = new Set(latest("application_autofill"));
  for (const r of all)
    if (
      r.kind === "application_autofill" &&
      (packagedScripts.has(r.id) || currentScripts.has(r))
    )
      keep([r.id, r.value.attachments]);
  return values;
}

function planRetention(store: Store, owners?: Set<string>) {
  const all = load(store, [
    "generated_document",
    "cache_document",
    "application",
    "application_preparation",
    "application_autofill",
    "task",
    "bundle",
  ]);
  const protect = protectedValues(all);
  const groups = new Map<string, Row[]>();
  for (const r of all) {
    if (
      r.kind !== "generated_document" ||
      !tailored(r.value) ||
      !documentRetentionOwner(r.value)
    )
      continue;
    if (owners && !owners.has(documentRetentionOwner(r.value))) continue;
    const key = [
      documentRetentionOwner(r.value),
      r.value.kind,
      r.value.privacy,
    ].join("\n");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const removed = new Map<string, Row>();
  const remove = (r: Row) => removed.set(`${r.kind}:${r.id}`, r);
  for (const versions of groups.values()) {
    // Rows are in insertion order, so the later row wins a timestamp tie.
    const newest = versions
      .map((r, index) => ({ r, index }))
      .sort(
        (a, b) =>
          String(b.r.value.createdAt ?? "").localeCompare(
            String(a.r.value.createdAt ?? ""),
          ) || b.index - a.index,
      )
      .map(({ r }) => r);
    for (const r of newest.slice(tunable(store, "documents.retainedVersions")))
      if (!protect.has(r.id)) remove(r);
  }
  const docs = [...removed.values()];
  if (!docs.length) return null;
  const docIds = new Set(docs.map((r) => r.id));
  const keptHashes = new Set([
    ...protect,
    ...all
      .filter(
        (r) =>
          ["generated_document", "cache_document"].includes(r.kind) &&
          !docIds.has(r.id),
      )
      .flatMap((r) => [r.value.hash, r.value.sourceHash]),
  ]);
  const hashes = new Set<string>(
    docs.map((r) => r.value.hash).filter((h) => h && !keptHashes.has(h)),
  );
  // An older script embeds its files, so it goes with them.
  for (const r of all)
    if (
      r.kind === "application_autofill" &&
      !protect.has(r.id) &&
      (r.value.attachments ?? []).some(
        (a: any) => docIds.has(a.documentId) || hashes.has(a.hash),
      )
    )
      remove(r);
  // A generation task left with no document has nothing to show.
  const generators = new Set(
    docs.map((r) => r.value.generatedBy).filter(Boolean),
  );
  const tasks = all.filter(
    (r) =>
      r.kind === "task" &&
      generators.has(r.id) &&
      !protect.has(r.id) &&
      !isTaskBusy(r.value.status) &&
      all.every(
        (d) =>
          d.kind !== "generated_document" ||
          d.value.generatedBy !== r.id ||
          docIds.has(d.id),
      ),
  );
  for (const r of tasks) {
    remove(r);
    const bundle = all.find((b) => b.kind === "bundle" && b.id === r.id);
    if (bundle) remove(bundle);
  }
  return {
    all,
    removed: [...removed.values()],
    docs,
    hashes,
    taskIds: tasks.map((r) => r.id),
  };
}

/** Drops references to removed records and every listed copy of their bytes. */
function scrub(value: any, gone: (v: unknown) => boolean): any {
  if (Array.isArray(value))
    return value
      .filter(
        (v) =>
          !gone(v) &&
          !(
            v &&
            typeof v === "object" &&
            (gone(v.id) || gone(v.documentId) || gone(v.hash))
          ),
      )
      .map((v) => scrub(v, gone));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k, v]) => !gone(k) && !gone(v))
      .map(([k, v]) => [k, scrub(v, gone)]),
  );
}

/** Retained records (full JSON) that mention a removed id or hash, found in one pass. */
function referencingRecords(store: Store, plan: Plan) {
  const removedKeys = new Set(plan.removed.map((r) => `${r.kind}:${r.id}`));
  const terms = new Set([...plan.removed.map((r) => r.id), ...plan.hashes]);
  const gone = (v: unknown) => typeof v === "string" && terms.has(v);
  const updates: Row[] = [];
  const dropped: Row[] = [];
  for (const r of store.db
    .prepare("SELECT kind,id,json FROM records ORDER BY rowid")
    .iterate() as Iterable<{
    kind: Kind;
    id: string;
    json: string;
  }>) {
    if (
      removedKeys.has(`${r.kind}:${r.id}`) ||
      ["deleted_record", "settings"].includes(r.kind)
    )
      continue;
    // Planning omits logs, but removal must scrub copies and references inside surviving histories too.
    const json =
      r.kind === "task"
        ? JSON.stringify({
            ...JSON.parse(r.json),
            events: store.taskEvents(r.id),
          })
        : r.json;
    if (
      !(json.match(referenceTokens) ?? []).some((t) => terms.has(t)) &&
      !terms.has(r.id)
    )
      continue;
    const value = JSON.parse(json);
    if (
      (r.kind === "journal" && gone(value.entityId)) ||
      (r.kind === "personal" && gone(r.id))
    ) {
      dropped.push({ kind: r.kind, id: r.id, value });
      continue;
    }
    const after = scrub(value, gone);
    if (JSON.stringify(after) !== json)
      updates.push({ kind: r.kind, id: r.id, value: after });
  }
  return { updates, dropped };
}

/** Stored copies of removed bytes: whole drafts of removed tasks, matching files in kept drafts. */
function draftFiles(store: Store, plan: Plan) {
  const files = new Map<string, FileEdit>();
  const drop = (file: string, hash?: string) => {
    ownedPath(store, file);
    if (!existsSync(file) || files.has(file)) return;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Retention refused an unsafe path: ${file}`);
    const before = readFileSync(file);
    if (!hash || sha256(before) === hash) files.set(file, { file, before });
  };
  const walk = (dir: string) => {
    ownedPath(store, dir);
    if (!existsSync(dir)) return;
    if (lstatSync(dir).isSymbolicLink())
      throw new Error(`Retention refused a linked directory: ${dir}`);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (lstatSync(file).isDirectory() && !lstatSync(file).isSymbolicLink())
        walk(file);
      else drop(file);
    }
  };
  const draft = (taskId: string) => {
    if (!/^[a-f0-9-]{36}$/i.test(taskId))
      throw new Error(`Invalid task directory identity: ${taskId}`);
    return path.join(store.dataDir, "drafts", taskId);
  };
  const removedTasks = new Set(plan.taskIds);
  for (const id of removedTasks) walk(draft(id));
  for (const r of plan.all)
    if (r.kind === "bundle" && !removedTasks.has(r.id))
      for (const a of r.value.artifacts ?? [])
        if (plan.hashes.has(a.hash))
          drop(path.join(draft(r.id), a.path), a.hash);
  for (const r of plan.docs) {
    const file = r.value.path && path.resolve(store.root, r.value.path);
    if (
      file &&
      plan.hashes.has(r.value.hash) &&
      file.startsWith(path.join(store.dataDir, "drafts") + path.sep)
    )
      drop(file, r.value.hash);
  }
  return {
    files: [...files.values()],
    directories: [...removedTasks].map(draft),
  };
}

/** What a full pass would remove; nothing is changed. */
export function previewDocumentRetention(
  store: Store,
): DocumentRetentionPreview {
  const plan = planRetention(store);
  if (!plan)
    return {
      documents: [],
      scripts: [],
      tasks: [],
      files: [],
      updatedRecords: 0,
    };
  return {
    documents: plan.docs.map((r) => ({
      id: r.id,
      name: r.value.name,
      kind: r.value.kind,
      privacy: r.value.privacy,
      owner: documentRetentionOwner(r.value),
      createdAt: r.value.createdAt,
    })),
    scripts: plan.removed
      .filter((r) => r.kind === "application_autofill")
      .map((r) => r.id),
    tasks: plan.taskIds,
    files: draftFiles(store, plan).files.map((f) =>
      path.relative(store.root, f.file),
    ),
    updatedRecords: referencingRecords(store, plan).updates.length,
  };
}

/**
 * Removes generated documents beyond the newest two of their Opening, kind and
 * privacy, with the scripts that embed them, generation tasks left without a
 * document, every stored copy of their bytes and every reference to them.
 * `owners` limits the pass to those Openings (or legacy posting labels).
 */
export function applyDocumentRetention(
  store: Store,
  owners?: Iterable<string>,
) {
  const plan = planRetention(store, owners ? new Set(owners) : undefined);
  if (!plan)
    return { documents: 0, scripts: 0, tasks: 0, files: 0, objects: 0 };
  const { files, directories } = draftFiles(store, plan);
  const { updates, dropped } = referencingRecords(store, plan);
  const deleted: FileEdit[] = [];
  try {
    for (const edit of files) {
      unlinkSync(edit.file);
      deleted.push(edit);
    }
    store.transaction(() => {
      for (const r of plan.removed) {
        store.remove(r.kind, r.id);
        const identityHash = sha256(`${r.kind}:${r.id}`);
        store.put("deleted_record", identityHash, {
          id: identityHash,
          kind: r.kind,
          identityHash,
          deletedAt: now(),
        });
      }
      for (const r of dropped) store.remove(r.kind, r.id);
      for (const r of updates) {
        if (r.kind === "task") putTaskWithEvents(store, r.id, r.value);
        else store.put(r.kind, r.id, r.value);
      }
    });
  } catch (error) {
    for (const edit of deleted.reverse()) atomicWrite(edit.file, edit.before);
    throw error;
  }
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  // Objects go only once nothing retained lists them.
  const referenced = new Set(referencedBackupObjects(store));
  let objects = 0;
  for (const r of plan.removed)
    for (const hash of [
      r.value.hash,
      r.value.sourceHash,
      r.value.scriptHash,
      r.value.evidenceHash,
      ...(r.value.attachments ?? []).map((a: any) => a.hash),
      ...(r.kind === "bundle"
        ? (r.value.artifacts ?? []).map((a: any) => a.hash)
        : []),
    ]) {
      if (
        typeof hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        referenced.has(hash)
      )
        continue;
      const file = store.objectPath(hash);
      if (existsSync(file)) {
        unlinkSync(file);
        objects++;
      }
    }
  const result = {
    documents: plan.docs.length,
    scripts: plan.removed.filter((r) => r.kind === "application_autofill")
      .length,
    tasks: plan.taskIds.length,
    files: files.length,
    objects,
  };
  store.journal(
    "document_retention",
    `Removed ${result.documents} older generated document${result.documents === 1 ? "" : "s"}`,
    undefined,
    result,
  );
  store.autoExport();
  return result;
}
