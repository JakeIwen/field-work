import path from "node:path";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  Store,
  HttpError,
  MissingRecordError,
  atomicWrite,
  sha256,
  safeSource,
  now,
} from "./storage.js";
import { draftPath } from "./bundles.js";

import {
  currentResumePath as MASTER,
  evidenceDossierPath as EVIDENCE,
  sourceReadmePath as SOURCE_README,
} from "../shared/workspace-sources.js";
const ROOT_README = "README.md";
const promoting = new Set<string>();
type Artifact = {
  path: string;
  hash: string;
  format: string;
  [key: string]: unknown;
};

function validatePromotionBundle(store: Store, id: string) {
  const task = store.get("task", id);
  if (!task) throw new MissingRecordError(404, "task", id, "Task missing");
  const bundle = store.get("bundle", id);
  if (!bundle)
    throw new MissingRecordError(
      409,
      "bundle",
      id,
      "The revision bundle is missing.",
    );
  if (bundle.promotion?.status === "completed")
    throw new HttpError(409, "This bundle was already promoted");
  if (
    bundle.scope === "tailored" ||
    String(bundle.versionDir).startsWith("employer_specific/")
  )
    throw new HttpError(
      400,
      "This is an employer-specific resume bundle. General-master promotion is unavailable; preserve its separate tailored master and export the validated tailored artifacts.",
    );
  if (
    task?.preset !== "resume-revision" ||
    !/^source_master_template\/v\d+(?:_[a-z]+)?$/.test(bundle.versionDir ?? "")
  )
    throw new HttpError(
      400,
      "Only an isolated general resume revision bundle can be promoted",
    );
  if (
    bundle.status !== "validated" ||
    bundle.validation?.status !== "passed" ||
    !bundle.validation.checks?.length ||
    bundle.validation.checks.some((check: any) => check.status !== "passed")
  )
    throw new HttpError(
      409,
      "All bundle validation checks must pass before promotion",
    );
  return { bundle, task };
}

type ValidatedPromotion = ReturnType<typeof validatePromotionBundle>;
type PromotionBundle = ValidatedPromotion["bundle"];
type PromotionTask = ValidatedPromotion["task"];
type PromotionState = {
  manifest: any;
  applied: { relative: string; previous: Buffer; newHash: string }[];
  newDirectory: string | undefined;
  lockFd: number;
};
type VersionPlan = ReturnType<typeof createVersionDirectory>;
type ValidatedArtifacts = ReturnType<typeof validatePromotionArtifacts>;

function validatePromotionSources(
  store: Store,
  root: string,
  id: string,
  bundle: PromotionBundle,
  expectedSourceHashes?: Record<string, string>,
) {
  const dataRoot = realpathSync(store.dataDir),
    draftsRoot = path.join(dataRoot, "drafts"),
    bundleRoot = path.join(draftsRoot, id);
  if (
    realpathSync(draftsRoot) !== draftsRoot ||
    realpathSync(bundleRoot) !== bundleRoot
  )
    throw new HttpError(
      403,
      "Draft root must be a real directory within the configured data directory",
    );
  for (const relative of [MASTER, EVIDENCE, SOURCE_README, ROOT_README])
    if (!/^[a-f0-9]{64}$/.test(bundle.sourceHashes?.[relative] ?? ""))
      throw new HttpError(
        409,
        `This draft has no original hash for ${relative}. Create a fresh revision task before promotion.`,
      );
  const sourceHashes: Record<string, string> = bundle.sourceHashes;
  if (
    expectedSourceHashes &&
    Object.entries(expectedSourceHashes).some(
      ([relative, hash]) => sourceHashes[relative] !== hash,
    )
  )
    throw new HttpError(
      409,
      "The reviewed source manifest differs from this bundle",
    );
  return sourceHashes;
}

function rootReadme(root: string) {
  const full = path.join(root, ROOT_README);
  if (realpathSync(full) !== full || !lstatSync(full).isFile())
    throw new HttpError(
      403,
      "Root README must be a regular file within this checkout",
    );
  return full;
}

function sourceBytes(root: string, relative: string) {
  return readFileSync(
    relative === ROOT_README ? rootReadme(root) : safeSource(root, relative),
  );
}

function checkOriginals(root: string, sourceHashes: Record<string, string>) {
  for (const [relative, expected] of Object.entries(sourceHashes)) {
    let actual = "missing";
    try {
      actual = sha256(sourceBytes(root, relative));
    } catch {}
    if (actual !== expected)
      throw new HttpError(
        409,
        `External edit detected in ${relative}. The original files were not overwritten. Rebase this draft and validate again.`,
      );
  }
}

function draftBytes(
  store: Store,
  id: string,
  byPath: Map<string, Artifact>,
  relative: string,
) {
  const artifact = byPath.get(relative);
  if (!artifact)
    throw new HttpError(
      409,
      `Required artifact was not part of validation: ${relative}`,
    );
  const full = draftPath(store, id, relative);
  if (lstatSync(full).isSymbolicLink())
    throw new HttpError(403, "Symbolic links cannot be promoted");
  const bytes = readFileSync(full);
  if (sha256(bytes) !== artifact.hash)
    throw new HttpError(
      409,
      `Draft artifact changed since validation: ${relative}. Validate again.`,
    );
  return bytes;
}

function oneValidatedArtifact(
  artifacts: Artifact[],
  versionDir: string | null | undefined,
  format: string,
  privacy: "private" | "public",
) {
  const candidates = artifacts.filter(
    (a) =>
      path.posix.dirname(a.path) === versionDir &&
      a.format === format &&
      /_public\./i.test(a.path) === (privacy === "public"),
  );
  if (candidates.length !== 1)
    throw new HttpError(
      409,
      `Select one unambiguous validated ${privacy} ${format.toUpperCase()} artifact`,
    );
  return candidates[0];
}

function validatePromotionArtifacts(
  store: Store,
  id: string,
  bundle: PromotionBundle,
  sourceHashes: Record<string, string>,
) {
  const artifacts: Artifact[] = bundle.artifacts ?? [];
  const byPath = new Map(
    artifacts.map((artifact) => [artifact.path, artifact]),
  );
  for (const artifact of artifacts)
    draftBytes(store, id, byPath, artifact.path);
  const privateHtml = oneValidatedArtifact(
      artifacts,
      bundle.versionDir,
      "html",
      "private",
    ),
    publicHtml = oneValidatedArtifact(
      artifacts,
      bundle.versionDir,
      "html",
      "public",
    ),
    privatePdf = oneValidatedArtifact(
      artifacts,
      bundle.versionDir,
      "pdf",
      "private",
    ),
    publicPdf = oneValidatedArtifact(
      artifacts,
      bundle.versionDir,
      "pdf",
      "public",
    );
  const newMaster = draftBytes(store, id, byPath, MASTER),
    newEvidence = draftBytes(store, id, byPath, EVIDENCE);
  if (
    sha256(newMaster) !== sourceHashes[MASTER] &&
    sha256(newEvidence) === sourceHashes[EVIDENCE]
  )
    throw new HttpError(
      409,
      "The revised content needs a corresponding evidence dossier update",
    );
  return {
    artifacts,
    byPath,
    privateHtml,
    publicHtml,
    privatePdf,
    publicPdf,
    newMaster,
    newEvidence,
  };
}

function validatedTemplateRoot(root: string) {
  const templateRoot = path.join(root, "source_master_template");
  if (realpathSync(templateRoot) !== templateRoot)
    throw new HttpError(403, "Resume version root cannot be a symbolic link");
  return templateRoot;
}

function acquirePromotionLock(templateRoot: string) {
  const lock = path.join(templateRoot, ".promotion.lock");
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch {
    throw new HttpError(
      409,
      "Another promotion holds source_master_template/.promotion.lock. If a previous process stopped, inspect the recorded transaction before removing its stale lock.",
    );
  }
  return { lock, lockFd };
}

function initializePromotionState(
  store: Store,
  id: string,
  bundle: PromotionBundle,
  sourceHashes: Record<string, string>,
  artifacts: Artifact[],
  lockFd: number,
) {
  const at = now(),
    promotionId = `${at.replace(/[:.]/g, "-")}-${id}`;
  const transactionPath = path.join(
    store.dataDir,
    "promotions",
    `${promotionId}.json`,
  );
  const state: PromotionState = {
    manifest: {
      schemaVersion: 1,
      id: promotionId,
      taskId: id,
      at,
      status: "preparing",
      sourceHashes,
      validation: bundle.validation,
      validationArtifacts: artifacts,
      updates: [],
    },
    applied: [],
    newDirectory: undefined,
    lockFd,
  };
  return { at, promotionId, transactionPath, state };
}

function writePromotionLock(
  state: PromotionState,
  promotionId: string,
  at: string,
  transactionPath: string,
) {
  writeFileSync(
    state.lockFd,
    JSON.stringify({
      id: promotionId,
      pid: process.pid,
      at,
      transactionPath,
    }),
  );
  closeSync(state.lockFd);
  state.lockFd = -1;
}

function createVersionDirectory(
  root: string,
  templateRoot: string,
  bundle: PromotionBundle,
  state: PromotionState,
) {
  const max = Math.max(
    0,
    ...readdirSync(templateRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => Number(d.name.match(/^v(\d+)(?:_|$)/)?.[1] ?? 0)),
  );
  const version = `v${max + 1}`,
    oldVersion = path.posix.basename(bundle.versionDir!),
    relativeDir = `source_master_template/${version}`;
  state.newDirectory = path.join(root, relativeDir);
  mkdirSync(state.newDirectory, { mode: 0o700 });
  const privateHtmlName = `resume_2026_design_source_${version}.html`,
    publicHtmlName = `resume_2026_design_source_${version}_public.html`;
  const privatePdfName = `resume_${version}_private.pdf`,
    publicPdfName = `resume_${version}_public.pdf`;
  return {
    version,
    oldVersion,
    relativeDir,
    privateHtmlName,
    publicHtmlName,
    privatePdfName,
    publicPdfName,
  };
}

function rewriteReferences(
  text: string,
  bundleVersionDir: string | null | undefined,
  relativeDir: string,
  oldVersion: string,
  version: string,
) {
  return text
    .replaceAll(`${bundleVersionDir}/`, `${relativeDir}/`)
    .replaceAll(`_source_${oldVersion}`, `_source_${version}`)
    .replaceAll(`_2026_${oldVersion}`, `_2026_${version}`)
    .replace(
      new RegExp(
        `\\[Version ${oldVersion.slice(1)}\\](?=\\(${relativeDir.replaceAll("/", "\\/")})`,
        "g",
      ),
      `[Version ${version.slice(1)}]`,
    );
}

function prepareVersionFiles(
  root: string,
  store: Store,
  id: string,
  bundle: PromotionBundle,
  sourceHashes: Record<string, string>,
  validated: ValidatedArtifacts,
  plan: VersionPlan,
  at: string,
) {
  const files = new Map<string, Buffer>([
    ["resume.md", validated.newMaster],
    [
      plan.privateHtmlName,
      draftBytes(store, id, validated.byPath, validated.privateHtml.path),
    ],
    [
      plan.publicHtmlName,
      draftBytes(store, id, validated.byPath, validated.publicHtml.path),
    ],
    [
      plan.privatePdfName,
      draftBytes(store, id, validated.byPath, validated.privatePdf.path),
    ],
    [
      plan.publicPdfName,
      draftBytes(store, id, validated.byPath, validated.publicPdf.path),
    ],
  ]);
  // Copy only original, hash-checked tooling. Agent-written executables are never promoted.
  for (const [relative] of Object.entries(sourceHashes))
    if (
      path.posix.dirname(relative) === bundle.versionDir &&
      relative.endsWith(".swift")
    )
      files.set(
        path.posix.basename(relative),
        Buffer.from(
          sourceBytes(root, relative)
            .toString("utf8")
            .replaceAll(plan.oldVersion, plan.version),
        ),
      );
  const priorNotes = validated.byPath.has(
    `${bundle.versionDir}/revision_notes.md`,
  )
    ? draftBytes(
        store,
        id,
        validated.byPath,
        `${bundle.versionDir}/revision_notes.md`,
      ).toString("utf8")
    : "";
  const revisionNotes = `# Resume ${plan.version} revision bundle\n\nRevised ${at.slice(0, 10)}. Promoted explicitly at ${at} from task ${id}.\n\nPrevious general version: ${plan.oldVersion}. Prior directories remain unchanged.\n\n## Validation\n\nAll checks passed at ${bundle.validation!.at}. The HTML and PDF bytes below are exactly the validated artifacts; promotion did not rerender them. The version-specific Markdown is an exact copy of the promoted content master.\n\n${bundle.validation!.checks!.map((c: any) => `- ${c.name}: ${c.status}`).join("\n")}\n\n## Files\n\n- ${plan.privateHtmlName}: private HTML\n- ${plan.publicHtmlName}: public HTML, phone omitted\n- ${plan.privatePdfName}: private PDF\n- ${plan.publicPdfName}: public PDF\n- resume.md: general content snapshot\n- promotion-manifest.json: validated input hashes and final artifact mappings\n\nOriginal hash-checked Swift tools, when present, are copied with version filename references updated.\n\n## Validated draft revision notes\n\n${priorNotes || "No separate draft notes were supplied."}\n`;
  files.set("revision_notes.md", Buffer.from(revisionNotes));
  return files;
}

function prepareAuthorityUpdates(
  root: string,
  bundle: PromotionBundle,
  validated: ValidatedArtifacts,
  plan: VersionPlan,
  at: string,
) {
  let sourceReadme = rewriteReferences(
    sourceBytes(root, SOURCE_README).toString("utf8"),
    bundle.versionDir,
    plan.relativeDir,
    plan.oldVersion,
    plan.version,
  );
  if (!sourceReadme.includes(`${plan.relativeDir}/`))
    throw new HttpError(
      409,
      "Current version reference could not be updated in source_data/README.md",
    );
  sourceReadme = sourceReadme.replace(
    /(current general content master[^\n]*?synchronized to `[^`]+`) on [^.\n]+\./i,
    `$1 on ${at.slice(0, 10)}.`,
  );
  const rootReadmeText = rewriteReferences(
    sourceBytes(root, ROOT_README).toString("utf8"),
    bundle.versionDir,
    plan.relativeDir,
    plan.oldVersion,
    plan.version,
  );
  return new Map<string, Buffer>([
    [MASTER, validated.newMaster],
    [EVIDENCE, validated.newEvidence],
    [SOURCE_README, Buffer.from(sourceReadme)],
    [ROOT_README, Buffer.from(rootReadmeText)],
  ]);
}

function prepareTransactionManifest(
  state: PromotionState,
  plan: VersionPlan,
  files: Map<string, Buffer>,
  updates: Map<string, Buffer>,
  sourceHashes: Record<string, string>,
) {
  state.manifest = {
    ...state.manifest,
    status: "prepared",
    version: plan.version,
    versionDirectory: plan.relativeDir,
    files: [...files].map(([name, bytes]) => ({
      path: `${plan.relativeDir}/${name}`,
      hash: sha256(bytes),
    })),
    updates: [...updates].map(([relative, bytes]) => ({
      path: relative,
      previousHash: sourceHashes[relative],
      hash: sha256(bytes),
    })),
  };
}

function persistPreparedPromotion(
  store: Store,
  root: string,
  transactionPath: string,
  state: PromotionState,
  files: Map<string, Buffer>,
  updates: Map<string, Buffer>,
) {
  for (const [relative] of updates) {
    const bytes = sourceBytes(root, relative);
    atomicWrite(store.objectPath(sha256(bytes)), bytes);
  }
  atomicWrite(transactionPath, JSON.stringify(state.manifest, null, 2));
  for (const [name, bytes] of files)
    writeFileSync(path.join(state.newDirectory!, name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  writeFileSync(
    path.join(state.newDirectory!, "promotion-manifest.json"),
    JSON.stringify(state.manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
}

function applyAuthorityUpdates(
  root: string,
  sourceHashes: Record<string, string>,
  updates: Map<string, Buffer>,
  state: PromotionState,
) {
  // Final synchronous preflight plus per-file checks are optimistic concurrency,
  // not a promise that an unrelated external editor participates in this lock.
  checkOriginals(root, sourceHashes);
  for (const [relative, bytes] of updates) {
    const previous = sourceBytes(root, relative);
    if (sha256(previous) !== sourceHashes[relative])
      throw new HttpError(
        409,
        `External edit detected during promotion: ${relative}`,
      );
    atomicWrite(path.join(root, relative), bytes);
    state.applied.push({ relative, previous, newHash: sha256(bytes) });
  }
}

function commitPromotion(
  store: Store,
  id: string,
  bundle: PromotionBundle,
  task: PromotionTask,
  transactionPath: string,
  state: PromotionState,
  plan: VersionPlan,
  updates: Map<string, Buffer>,
  at: string,
) {
  state.manifest = {
    ...state.manifest,
    status: "completed",
    completedAt: now(),
  };
  atomicWrite(transactionPath, JSON.stringify(state.manifest, null, 2));
  atomicWrite(
    path.join(state.newDirectory!, "promotion-manifest.json"),
    JSON.stringify(state.manifest, null, 2),
  );
  const promoted = {
    ...bundle,
    status: "promoted",
    version: bundle.version + 1,
    promotion: {
      status: "completed",
      at,
      version: plan.version,
      versionDirectory: plan.relativeDir,
      transactionPath: path.relative(store.dataDir, transactionPath),
    },
  };
  store.put("bundle", id, promoted);
  store.put("task", id, { ...task, bundle: promoted, updatedAt: now() });
  store.journal(
    "resume_promoted",
    `Promoted validated general resume ${plan.version}`,
    id,
    {
      version: plan.version,
      versionDirectory: plan.relativeDir,
      validationAt: bundle.validation!.at,
    },
  );
  store.autoExport();
  return {
    bundle: promoted,
    version: plan.version,
    versionDirectory: plan.relativeDir,
    files: state.manifest.files,
    sourceHashes: Object.fromEntries(
      [...updates].map(([relative, bytes]) => [relative, sha256(bytes)]),
    ),
  };
}

function rollbackPromotion(
  store: Store,
  id: string,
  root: string,
  transactionPath: string,
  state: PromotionState,
  error: unknown,
) {
  const rollbackConflicts: string[] = [];
  for (const entry of state.applied.reverse()) {
    try {
      if (sha256(sourceBytes(root, entry.relative)) === entry.newHash)
        atomicWrite(path.join(root, entry.relative), entry.previous);
      else rollbackConflicts.push(entry.relative);
    } catch {
      rollbackConflicts.push(entry.relative);
    }
  }
  state.manifest = {
    ...state.manifest,
    status: rollbackConflicts.length ? "recovery-required" : "failed",
    error: String(error),
    rollbackConflicts,
    versionDirectory: state.newDirectory
      ? path.relative(root, state.newDirectory)
      : null,
  };
  atomicWrite(transactionPath, JSON.stringify(state.manifest, null, 2));
  if (state.newDirectory && existsSync(state.newDirectory))
    atomicWrite(
      path.join(state.newDirectory, "promotion-manifest.json"),
      JSON.stringify(state.manifest, null, 2),
    );
  store.journal(
    "promotion_failed",
    "Resume promotion failed; inspect the transaction record before retrying",
    id,
    {
      transactionPath: path.relative(store.dataDir, transactionPath),
      rollbackConflicts,
      error: String(error),
    },
  );
  store.autoExport();
}

function releasePromotionLock(
  root: string,
  lock: string,
  state: PromotionState,
) {
  if (state.lockFd >= 0)
    try {
      closeSync(state.lockFd);
    } catch {}
  try {
    unlinkSync(lock);
  } catch {}
  promoting.delete(root);
}

/** Explicit, validated general-master promotion. Never called as a side effect of import. */
export function promoteBundle(
  store: Store,
  id: string,
  expectedSourceHashes?: Record<string, string>,
) {
  const root = realpathSync(store.root);
  if (promoting.has(root))
    throw new HttpError(409, "Another general resume promotion is in progress");
  const { bundle, task } = validatePromotionBundle(store, id);
  const sourceHashes = validatePromotionSources(
    store,
    root,
    id,
    bundle,
    expectedSourceHashes,
  );
  checkOriginals(root, sourceHashes);
  const validated = validatePromotionArtifacts(store, id, bundle, sourceHashes);
  const templateRoot = validatedTemplateRoot(root);
  const { lock, lockFd } = acquirePromotionLock(templateRoot);
  promoting.add(root);
  const { at, promotionId, transactionPath, state } = initializePromotionState(
    store,
    id,
    bundle,
    sourceHashes,
    validated.artifacts,
    lockFd,
  );
  try {
    writePromotionLock(state, promotionId, at, transactionPath);
    checkOriginals(root, sourceHashes);
    const plan = createVersionDirectory(root, templateRoot, bundle, state);
    const files = prepareVersionFiles(
      root,
      store,
      id,
      bundle,
      sourceHashes,
      validated,
      plan,
      at,
    );
    const updates = prepareAuthorityUpdates(root, bundle, validated, plan, at);
    prepareTransactionManifest(state, plan, files, updates, sourceHashes);
    persistPreparedPromotion(
      store,
      root,
      transactionPath,
      state,
      files,
      updates,
    );
    applyAuthorityUpdates(root, sourceHashes, updates, state);
    return commitPromotion(
      store,
      id,
      bundle,
      task,
      transactionPath,
      state,
      plan,
      updates,
      at,
    );
  } catch (error) {
    rollbackPromotion(store, id, root, transactionPath, state, error);
    throw error;
  } finally {
    releasePromotionLock(root, lock, state);
  }
}
