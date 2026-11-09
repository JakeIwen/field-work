import { putTaskWithEvents } from "./storage-task-events.js";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import {
  deletionKinds,
  type DeletionKind,
  type DeletionPreview,
} from "../shared/record-deletion.js";
import { isDeletionLeaf, leafDeletionPlan } from "./record-deletion-leaves.js";
import { removeDeletionRow } from "./record-deletion-tombstones.js";
import { deletionNeedsReindex } from "./record-deletion-reindex.js";
import { remainingDeletionWork } from "./workspace-activity.js";
import type { WorkspaceRuntime } from "./task-kinds/workspace-runtime.js";
import {
  Store,
  HttpError,
  sha256,
  atomicWrite,
  safeSource,
} from "./storage.js";
import {
  deletionRecordPlan,
  clearDeletionRecordPlan,
  deletionRowTitle as title,
  type DeletionRow,
} from "./record-deletion-records.js";

export type DeletionFileEdit = { file: string; before: Buffer; after?: Buffer };
/** Refuses paths outside the workspace or through a symbolic link. */
export function ownedPath(store: Store, file: string) {
  const absolute = path.resolve(file);
  const anchor = absolute.startsWith(store.dataDir + path.sep)
    ? store.dataDir
    : store.root;
  if (
    !absolute.startsWith(anchor + path.sep) ||
    realpathSync(anchor) !== anchor ||
    lstatSync(anchor).isSymbolicLink()
  )
    throw new HttpError(409, "Deletion path is outside this workspace.");
  let current = anchor;
  for (const part of path.relative(anchor, absolute).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new HttpError(409, "Deletion refused a linked path.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Labels of the work that must finish before these rows can be deleted.
 * A preparation or task blocks only when the cascade removes it: work for
 * other records never writes these rows, and an unrelated preparation held
 * every deletion until it finished. Workspace-wide jobs (scans, pulls,
 * rescans, sends) still block every deletion. Without `chosen`, all work
 * counts. */
export function deletionBlockers(
  store: Store,
  ctx?: WorkspaceRuntime,
  chosen?: Pick<DeletionRow, "kind" | "id">[],
) {
  const removed =
    chosen &&
    new Set(
      chosen.flatMap((row) =>
        row.kind === "application_preparation"
          ? [`preparation:${row.id}`]
          : row.kind === "task"
            ? [`task:${row.id}`]
            : [],
      ),
    );
  const work = remainingDeletionWork(store, ctx).filter(
    (item) =>
      !removed || !/^(preparation|task):/.test(item.id) || removed.has(item.id),
  );
  return [...new Set(work.map((item) => item.label))];
}

export function assertDeletionIdle(
  store: Store,
  ctx?: WorkspaceRuntime,
  chosen?: Pick<DeletionRow, "kind" | "id">[],
) {
  const blockers = deletionBlockers(store, ctx, chosen);
  if (blockers.length)
    throw new HttpError(
      409,
      `Wait for active generation or background work to finish, or pause it, before permanently deleting records: ${blockers.join(", ")}.`,
    );
}

// Database-only planning can reuse a write-version snapshot. File bytes,
// directory membership and path guards are always checked again at confirmation.
function planDeletion(store: Store, kind: DeletionKind, id: string) {
  if (!deletionKinds.includes(kind) || !id || id.length > 500)
    throw new HttpError(400, "Unsupported record identity");
  if (isDeletionLeaf(kind)) return leafDeletionPlan(store, kind, id);
  const {
    roots,
    chosen,
    kept,
    updates,
    companyIds,
    openingIds,
    taskIds,
    objectHashes,
    retainedHashes,
    recordsToken,
    scrub,
  } = deletionRecordPlan(store, kind, id);
  const edits = new Map<string, DeletionFileEdit>();
  const edit = (file: string, after?: string) => {
    ownedPath(store, file);
    if (!existsSync(file)) return;
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())
      throw new HttpError(409, "Deletion refused an unsafe file path.");
    const before = readFileSync(file),
      bytes = after === undefined ? undefined : Buffer.from(after);
    if (!bytes || !before.equals(bytes))
      edits.set(file, { file, before, after: bytes });
  };
  const visit = (dir: string, apply: (file: string) => void) => {
    ownedPath(store, dir);
    if (!existsSync(dir)) return;
    if (lstatSync(dir).isSymbolicLink())
      throw new HttpError(409, "Deletion refused a linked directory.");
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name),
        stat = lstatSync(file);
      if (stat.isSymbolicLink())
        throw new HttpError(409, "Deletion refused a linked file.");
      if (stat.isDirectory()) visit(file, apply);
      else if (stat.isFile()) apply(file);
    }
  };
  for (const [relative, level, match] of [
    [
      "company_careers/companies.md",
      "##",
      (section: string) =>
        companyIds.has(
          section.match(/<!--\s*company_id:\s*([^;\s]+)\s*-->/)?.[1] ?? "",
        ),
    ],
    [
      "company_careers/current_openings.md",
      "###",
      (section: string) => {
        const m = section.match(
          /<!--\s*company_id:\s*([^;\s]+);\s*job_id:\s*([^\s]+)\s*-->/,
        );
        return (
          !!m && (companyIds.has(m[1]) || openingIds.has(`${m[1]}:${m[2]}`))
        );
      },
    ],
  ] as const) {
    if (!companyIds.size && !openingIds.size) break;
    const file = safeSource(store.root, relative);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, "utf8"),
      parts = before.split(new RegExp(`(?=^${level}\\s+)`, "m"));
    let after = parts.filter((section) => !match(section)).join("");
    if (relative.endsWith("companies.md") && !/^##\s/m.test(after))
      after += "\nNo monitored companies.\n";
    if (relative.endsWith("current_openings.md"))
      after = after.replace(
        /(\*\*Qualifying current openings:\*\*) \d+/,
        `$1 ${(after.match(/^###\s/gm) ?? []).length}`,
      );
    edit(file, after);
  }
  if (companyIds.size || openingIds.size) {
    const files: string[] = [];
    visit(path.join(store.root, "company_careers/research/scans"), (file) => {
      if (file.endsWith(".json")) files.push(file);
    });
    const scanState = path.join(store.root, "company_careers/scan_state.json");
    if (existsSync(scanState)) files.push(scanState);
    for (const file of files) {
      const before = JSON.parse(readFileSync(file, "utf8")),
        after = scrub(before);
      if (JSON.stringify(before) !== JSON.stringify(after))
        edit(file, JSON.stringify(after ?? {}, null, 2) + "\n");
    }
  }
  for (const r of chosen.filter((r) =>
    ["cache_document", "generated_document"].includes(r.kind),
  )) {
    const d = r.value;
    if (
      r.kind === "cache_document" &&
      !kept.some(
        (r) =>
          r.kind === "cache_document" &&
          r.value.path === d.path &&
          r.value.hash === d.hash,
      )
    ) {
      const file = safeSource(store.root, d.path);
      if (existsSync(file)) {
        if (sha256(readFileSync(file)) !== d.hash) {
          if (
            d.availableInSource === false ||
            kept.some(
              (r) =>
                r.kind === "cache_document" &&
                r.value.path === d.path &&
                r.value.hash === sha256(readFileSync(file)),
            )
          )
            continue;
          throw new HttpError(
            409,
            "The source document changed. Rescan files before deleting it.",
          );
        }
        edit(file);
      }
    }
  }
  for (const taskId of taskIds) {
    if (!/^[a-f0-9-]{36}$/i.test(taskId))
      throw new HttpError(409, "Invalid task directory identity");
    visit(path.join(store.dataDir, "drafts", taskId), (file) => edit(file));
  }
  for (const r of chosen) {
    if (r.kind === "career_scan" && /^[a-f0-9-]{36}$/i.test(r.id)) {
      visit(path.join(store.dataDir, "careers-scans", r.id), (file) =>
        edit(file),
      );
      const snapshot = r.value.snapshotPath;
      if (
        typeof snapshot === "string" &&
        snapshot.startsWith("company_careers/research/scans/")
      ) {
        const dir = safeSource(store.root, snapshot);
        if (
          !kept.some(
            (k) =>
              k.kind === "career_scan" && k.value.snapshotPath === snapshot,
          )
        )
          visit(dir, (file) => edit(file));
      }
      const history = safeSource(store.root, "company_careers/scan_history.md");
      if (existsSync(history))
        edit(
          history,
          readFileSync(history, "utf8")
            .split(/(?=^##\s+)/m)
            .filter(
              (section) =>
                section.match(/<!--\s*scan_id:\s*([^\s]+)\s*-->/)?.[1] !== r.id,
            )
            .join(""),
        );
    }
  }
  let sharedFiles = 0;
  for (const hash of objectHashes) {
    if (retainedHashes.has(hash)) {
      sharedFiles++;
      continue;
    }
    edit(store.objectPath(hash));
  }
  const publicPlan = {
    title: title(roots[0]),
    records: chosen.map((r) => ({ kind: r.kind, id: r.id, title: title(r) })),
    updatedRecords: updates.map((r) => ({
      kind: r.kind,
      id: r.id,
      title: title(r),
    })),
    files: [...edits.values()]
      .filter((e) => !e.after)
      .map((e) => path.relative(store.root, e.file)),
    editedFiles: [...edits.values()]
      .filter((e) => e.after)
      .map((e) => path.relative(store.root, e.file)),
    sharedFiles,
  };
  const token = sha256(
    JSON.stringify({
      recordsToken,
      files: [...edits.values()].map((e) => [
        e.file,
        sha256(e.before),
        e.after ? sha256(e.after) : null,
      ]),
    }),
  );
  return {
    preview: { ...publicPlan, token } satisfies DeletionPreview,
    chosen,
    updates,
    edits,
  };
}

export function previewDeletion(
  store: Store,
  kind: DeletionKind,
  id: string,
  ctx?: WorkspaceRuntime,
): DeletionPreview {
  const plan = planDeletion(store, kind, id);
  // Checked per request, outside the cached plan, so a reopened or polling
  // dialog sees work finish.
  return isDeletionLeaf(kind)
    ? plan.preview
    : { ...plan.preview, blockedBy: deletionBlockers(store, ctx, plan.chosen) };
}

export function deleteRecord(
  store: Store,
  kind: DeletionKind,
  id: string,
  token: string,
  ctx?: WorkspaceRuntime,
) {
  const applied: DeletionFileEdit[] = [];
  let result;
  try {
    result = store.transaction(() => {
      const plan = planDeletion(store, kind, id);
      if (!isDeletionLeaf(kind)) assertDeletionIdle(store, ctx, plan.chosen);
      if (!token || token !== plan.preview.token)
        throw new HttpError(
          409,
          "The record or related files changed. Review a fresh deletion preview.",
        );
      for (const edit of plan.edits.values()) {
        if (edit.after) atomicWrite(edit.file, edit.after);
        else unlinkSync(edit.file);
        applied.push(edit);
      }
      for (const row of plan.chosen) removeDeletionRow(store, row);
      for (const row of plan.updates) {
        if (row.kind === "task") putTaskWithEvents(store, row.id, row.value);
        else store.put(row.kind, row.id, row.value);
      }
      return {
        deleted: true,
        records: plan.preview.records.length,
        files: plan.preview.files.length,
        reindex: deletionNeedsReindex(
          store,
          plan.chosen,
          plan.updates,
          plan.edits.keys(),
        ),
      };
    });
  } catch (error) {
    for (const edit of applied.reverse()) atomicWrite(edit.file, edit.before);
    throw error;
  } finally {
    clearDeletionRecordPlan(store);
  }
  store.autoExport();
  return result;
}
