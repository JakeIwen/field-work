import path from "node:path";
import { pdfVerifier } from "./paths.js";
import { bundleDocuments, type BundleDocument } from "./bundle-documents.js";
import {
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import type { Document } from "../shared/types.js";
import type {
  ArtifactRecord,
  Bundle,
  ValidationCheck,
} from "../shared/task-records.js";
import {
  Store,
  HttpError,
  MissingRecordError,
  atomicWrite,
  sha256,
  safeSource,
  now,
} from "./storage.js";

import { applicationSourceNeedsRefresh } from "./application-evidence.js";
import {
  assertGenerationActive,
  beginGeneration,
  runGenerationProcess,
} from "./generation-control.js";
import { remoteRenderConfigured } from "./remote-render-client.js";
import {
  currentResumePath as master,
  evidenceDossierPath as evidence,
} from "../shared/workspace-sources.js";
export function draftPath(store: Store, id: string, relative = "") {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      id,
    ) ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").includes("..") ||
    relative.includes("\0")
  )
    throw new HttpError(400, "Invalid draft path");
  if (
    lstatSync(store.dataDir).isSymbolicLink() ||
    realpathSync(store.dataDir) !== store.dataDir
  )
    throw new HttpError(403, "Application storage anchor changed");
  let current = store.dataDir;
  const components = [
    "drafts",
    id,
    ...relative.split("/").filter((p) => p && p !== "."),
  ];
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || realpathSync(current) !== current)
        throw new HttpError(403, "Draft paths cannot traverse symlinks");
      if (index < components.length - 1 && !stat.isDirectory())
        throw new HttpError(400, "A draft parent is not a directory");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return current;
}
export function prepareBundle(store: Store, task: any, privateOnly = false) {
  const documents = store.list("cache_document");
  const current = documents.filter(
    (d) => d.scope === "general" && d.status === "current",
  );
  const preferred = current.find(
    (d) =>
      d.path.startsWith("source_master_template/") &&
      d.path.endsWith(".html") &&
      !d.path.includes("_public"),
  );
  let versionDir = preferred ? path.posix.dirname(preferred.path) : null;
  let scope = "general";
  let bundleMaster = master;
  const paths = new Set<string>([
    "AGENTS.md",
    "README.md",
    "source_data/README.md",
    master,
    evidence,
  ]);
  const selected = (task.context?.documentIds ?? [])
    .map((id: string) => store.get("cache_document", id))
    .filter(Boolean) as Document[];
  const excludedDocuments: { id: string; path: string; reason: string }[] = [];
  const tailored =
    task.preset === "resume-revision"
      ? selected.filter((d) => d.scope === "tailored" && d.kind === "resume")
      : [];
  let targetDocuments: Document[] = [];
  if (tailored.length) {
    if (
      tailored.some(
        (d) => d.status !== "current" || d.availableInSource === false,
      )
    )
      throw new HttpError(
        400,
        "Select a current employer-specific resume to revise. Historical or missing tailored versions cannot establish the current tailored master.",
      );
    const directories = new Set<string>(
      tailored.map((d) => path.posix.dirname(d.path)),
    );
    if (directories.size !== 1)
      throw new HttpError(
        400,
        "Select resume variants from one employer-specific master directory for this revision task.",
      );
    versionDir = [...directories][0];
    if (!versionDir.startsWith("employer_specific/"))
      throw new HttpError(
        400,
        "The tailored resume must have a distinct employer-specific master directory.",
      );
    scope = "tailored";
    bundleMaster = `${versionDir}/resume.md`;
    targetDocuments = documents.filter(
      (d) =>
        d.scope === "tailored" &&
        d.kind === "resume" &&
        d.status === "current" &&
        d.availableInSource !== false &&
        path.posix.dirname(d.path) === versionDir,
    );
    if (
      !targetDocuments.some((d) => d.path === bundleMaster && d.format === "md")
    )
      throw new HttpError(
        400,
        `No clear current tailored Markdown master was found at ${bundleMaster}. Establish that master and reindex before starting a revision.`,
      );
    for (const format of ["html", "pdf"])
      for (const privacy of ["private", "public"]) {
        const variants = targetDocuments.filter(
          (d) => d.format === format && d.privacy === privacy,
        );
        if (variants.length !== 1)
          throw new HttpError(
            400,
            `The tailored resume requires one unambiguous ${privacy} ${format.toUpperCase()} variant in ${versionDir}. Reindex or resolve the missing/conflicting variants first.`,
          );
        paths.add(variants[0].path);
      }
    paths.add(bundleMaster);
  }
  selected.forEach((d) => {
    if (task.preset === "resume-revision" && d.kind !== "resume") {
      excludedDocuments.push({
        id: d.id,
        path: d.path,
        reason:
          "This is a resume revision bundle. Cover letters use a separate task and are excluded from resume/PDF validation.",
      });
      return;
    }
    paths.add(d.path);
  });
  if (task.preset === "resume-revision" && versionDir) {
    for (const file of readdirSync(path.join(store.root, versionDir))) {
      const resumeFile =
        scope === "general"
          ? /\.(md|html|pdf|swift)$/.test(file)
          : /^(?:README|.*notes|.*audit)\.md$/i.test(file) ||
            /^(?:verify_pdfs|render_resume)\.swift$/i.test(file);
      if (resumeFile) paths.add(`${versionDir}/${file}`);
    }
  }
  if (privateOnly)
    for (const relative of paths)
      if (/_public\.(?:html|pdf)$/i.test(relative)) paths.delete(relative);
  const sourceHashes: Record<string, string> = {};
  for (const relative of paths) {
    const bytes = readFileSync(safeSource(store.root, relative));
    sourceHashes[relative] = sha256(bytes);
    atomicWrite(draftPath(store, task.id, relative), bytes);
  }
  const instructions = readFileSync(path.join(store.root, "AGENTS.md"), "utf8");
  atomicWrite(
    draftPath(store, task.id, "AGENTS.md"),
    `${instructions}\n\n# Isolated application task\nThis is a draft copy, not the source repository. Work only inside this task directory. Do not edit the original checkout or global configuration. Preserve factual claims and prior versions. Never stage, commit, push, send applications/messages, purchase services, or publish without separate explicit user authorization. Source hashes and manifest are managed by the app. ${privateOnly ? "For this Opening, tailor only the private resume HTML/PDF and keep it synchronized with Markdown and evidence. Do not generate public tailored variants." : "For resume revisions keep Markdown, evidence and both HTML/PDF variants synchronized."} Do not claim validation passed without running the validators.\n\nRevision target scope: ${scope}. Content master: ${bundleMaster}. Artifact directory: ${versionDir ?? "not established"}.\n${scope === "tailored" ? `The general master at ${master} and its README are read-only reference context. Revise the selected employer-specific master and its private/public resume variants, with evidence updates. Do not advance or replace the general master. General-master promotion is unavailable for this tailored bundle.\n` : ""}`,
  );
  const opening = task.context?.openingId
    ? store.opening(task.context.openingId)
    : null;
  const company = task.context?.companyId
    ? (store.get("cache_company", task.context.companyId) ??
      store.get("custom_company", task.context.companyId))
    : null;
  const manifest = {
    schemaVersion: 1,
    taskId: task.id,
    createdAt: now(),
    sourceHashes,
    paths: [...paths],
    target: { scope, master: bundleMaster, versionDir },
    excludedDocuments,
    context: {
      opening,
      company,
      application: task.context?.applicationId
        ? store.get("application", task.context.applicationId)
        : null,
    },
    instruction:
      "Only selected context and required resume evidence were copied. Original checkout is read-only context. Private documents and raw archives are excluded.",
  };
  atomicWrite(
    draftPath(store, task.id, "context-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const bundle = {
    id: task.id,
    ...(privateOnly ? { privateOnly: true } : {}),
    status: "draft",
    version: 1,
    createdAt: now(),
    sourceHashes,
    paths: [...paths],
    versionDir,
    scope,
    master: bundleMaster,
    evidence,
    artifacts: [],
    validation: null,
  };
  store.put("bundle", task.id, bundle);
  return { bundle, manifest, cwd: draftPath(store, task.id) };
}
export function collectArtifacts(store: Store, id: string) {
  const base = draftPath(store, id);
  const files: ArtifactRecord[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(
      draftPath(store, id, path.relative(base, dir)),
      { withFileTypes: true },
    )) {
      if (entry.isSymbolicLink()) continue;
      const relative = path.join(path.relative(base, dir), entry.name);
      const p = draftPath(store, id, relative);
      if (entry.isDirectory()) {
        if (![".git", "node_modules"].includes(entry.name)) walk(p);
        continue;
      }
      const stat = lstatSync(p);
      if (
        !stat.isFile() ||
        !/\.(md|html|pdf|txt|json)$/.test(entry.name) ||
        stat.size > 8 * 1024 * 1024
      )
        continue;
      const data = readFileSync(p);
      const hash = sha256(data);
      atomicWrite(store.objectPath(hash), data);
      files.push({
        path: relative,
        hash,
        size: data.length,
        format: path.extname(p).slice(1),
      });
    }
  }
  walk(base);
  return files;
}
export function checkSources(
  store: Store,
  bundle: Bundle,
  applicationDraft = bundle.scope === "posting-draft",
) {
  return Object.entries(bundle.sourceHashes as Record<string, string>).flatMap(
    ([relative, expectedHash]) => {
      if (applicationDraft && !applicationSourceNeedsRefresh(relative))
        return [];
      try {
        const actualHash = sha256(
          readFileSync(safeSource(store.root, relative)),
        );
        return actualHash === expectedHash
          ? []
          : [{ path: relative, expectedHash, actualHash }];
      } catch {
        return [{ path: relative, expectedHash, actualHash: "missing" }];
      }
    },
  );
}
const validating = new Set<string>();
export async function validateBundle(
  store: Store,
  id: string,
  privateOnlyOverride = false,
) {
  if (validating.has(id))
    throw new HttpError(409, "Validation is already running for this bundle");
  const bundle = store.get("bundle", id);
  if (!bundle) throw new HttpError(404, "Draft bundle not found");
  const finishGeneration = beginGeneration(store);
  validating.add(id);
  try {
    const privateOnly = privateOnlyOverride || bundle.privateOnly === true;
    const checks: ValidationCheck[] = [];
    const conflicts = checkSources(store, bundle);
    checks.push({
      name: "Original source hashes",
      status: conflicts.length ? "failed" : "passed",
      output: conflicts.length
        ? JSON.stringify(conflicts, null, 2)
        : "Original source files still match the task context.",
    });
    const artifacts = collectArtifacts(store, id);
    const before = JSON.stringify(artifacts.map((x) => [x.path, x.hash]));
    if (bundle.versionDir) {
      const selected = bundleDocuments(
        artifacts,
        bundle.versionDir,
        bundle.master!,
        privateOnly,
      );
      if (selected.errors.length)
        checks.push({
          name: "Document selection",
          status: "failed",
          output: selected.errors.join("\n"),
        });
      for (const document of selected.documents) {
        const label = document.kind === "resume" ? "Resume" : "Cover letter";
        const htmlCheck = `${label}: Markdown and ${privateOnly ? "private" : "private/public"} HTML`;
        try {
          const result = await runGenerationProcess(
            store,
            "python3",
            [
              path.join(store.root, "source_data/verify_resume_source_sync.py"),
              draftPath(store, id, document.source),
              draftPath(store, id, document.privateHtml),
              ...(document.publicHtml
                ? [draftPath(store, id, document.publicHtml)]
                : []),
            ],
            {
              cwd: draftPath(store, id),
              timeout: 30000,
              maxBuffer: 1024 * 1024,
            },
          );
          checks.push({
            name: htmlCheck,
            status: "passed",
            output: result.stdout + result.stderr,
          });
        } catch (e: any) {
          checks.push({
            name: htmlCheck,
            status: "failed",
            output: (e.stdout ?? "") + (e.stderr ?? "") + e.message,
          });
        }
        const pdfCheck = `${label}: PDF page count and selectable text`;
        if (process.platform === "darwin" || remoteRenderConfigured()) {
          try {
            const result = await runGenerationProcess(
              store,
              "swift",
              [
                "-module-cache-path",
                path.join(store.dataDir, "swift-cache"),
                pdfVerifier,
                ...(document.kind === "cover-letter" ? ["--cover-letter"] : []),
                draftPath(store, id, document.source),
                draftPath(store, id, document.privatePdf),
                ...(document.publicPdf
                  ? [draftPath(store, id, document.publicPdf)]
                  : []),
              ],
              { timeout: 60000, maxBuffer: 1024 * 1024 },
            );
            checks.push({
              name: pdfCheck,
              status: "passed",
              output: result.stdout + result.stderr,
            });
          } catch (e: any) {
            checks.push({
              name: pdfCheck,
              status: "failed",
              output: (e.stdout ?? "") + (e.stderr ?? "") + e.message,
            });
          }
        } else {
          checks.push({
            name: pdfCheck,
            status: "unavailable",
            output:
              "The native PDFKit verifier requires macOS. Run the documented verifier on the Mac before promoting this bundle.",
          });
        }
      }
      const resume = selected.documents.find((d) => d.kind === "resume");
      checks.push(evidenceRevisionCheck(bundle, artifacts, resume));
    } else
      checks.push({
        name: "Resume bundle",
        status: "unavailable",
        output:
          "No current general resume HTML was found when this task was created.",
      });
    const after = collectArtifacts(store, id);
    if (before !== JSON.stringify(after.map((x) => [x.path, x.hash])))
      checks.push({
        name: "Draft concurrency",
        status: "failed",
        output:
          "Draft files changed while validation was running. Validate again.",
      });
    const validation = {
      at: now(),
      status: checks.every((c) => c.status === "passed") ? "passed" : "failed",
      checks,
      conflicts,
    };
    const result = {
      ...bundle,
      artifacts: after,
      validation,
      status: validation.status === "passed" ? "validated" : "failed",
      version: bundle.version + 1,
    };
    assertGenerationActive(store);
    store.put("bundle", id, result);
    const task = store.get("task", id);
    if (task)
      store.put("task", id, { ...task, bundle: result, updatedAt: now() });
    if (validation.status !== "passed")
      store.journal("validation", `Draft validation ${validation.status}`, id, {
        checks,
      });
    store.autoExport();
    return result;
  } finally {
    validating.delete(id);
    finishGeneration();
  }
}
function evidenceRevisionCheck(
  bundle: Bundle,
  artifacts: ArtifactRecord[],
  resume?: BundleDocument,
): ValidationCheck {
  const sourceChanged = [bundle.master, resume?.privateHtml, resume?.publicHtml]
    .filter(Boolean)
    .some((p) => {
      const a = artifacts.find((a) => a.path === p);
      return a && a.hash !== bundle.sourceHashes[p!];
    });
  const evidenceArtifact = artifacts.find((a) => a.path === bundle.evidence);
  const missingUpdate =
    !bundle.privateOnly &&
    sourceChanged &&
    evidenceArtifact?.hash === bundle.sourceHashes[bundle.evidence!];
  return {
    name: "Evidence accompanies content revision",
    status: !evidenceArtifact || missingUpdate ? "failed" : "passed",
    output: !evidenceArtifact
      ? "Evidence dossier is missing."
      : missingUpdate
        ? "Resume content changed without an evidence update."
        : bundle.privateOnly
          ? "Evidence is present as read-only reference for tailoring."
          : "Evidence is present; content revisions require a corresponding dossier update.",
  };
}

export function writeDraftArtifact(
  store: Store,
  id: string,
  relative: string,
  expectedHash: string,
  content: string,
) {
  const task = store.get("task", id);
  if (!task) throw new MissingRecordError(404, "task", id, "Task missing");
  if (validating.has(id)) throw new HttpError(409, "Bundle is being validated");
  if (!/\.(md|html|txt)$/.test(relative) || content.length > 2 * 1024 * 1024)
    throw new HttpError(400, "Only bounded text artifacts can be edited");
  const prior = store.get("bundle", id);
  if (!prior)
    throw new MissingRecordError(409, "bundle", id, "Draft bundle missing");
  const p = draftPath(store, id, relative);
  if (!existsSync(p))
    throw new HttpError(404, "Artifact is not part of this draft");
  if (sha256(readFileSync(p)) !== expectedHash)
    throw new HttpError(
      409,
      "External edit detected. The source was not overwritten.",
    );
  atomicWrite(p, content);
  const bundle = {
    ...prior,
    status: "draft",
    validation: null,
    version: prior.version + 1,
    updatedAt: now(),
  };
  try {
    bundle.artifacts = collectArtifacts(store, id);
  } finally {
    store.transaction(() => {
      store.put("bundle", id, bundle);
      store.put("task", id, {
        ...task,
        bundle,
        updatedAt: now(),
        version: (task.version ?? 0) + 1,
      });
    });
    store.autoExport();
  }
  return { path: relative, hash: sha256(content), bundle };
}
