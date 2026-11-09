import path from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store, atomicWrite, now, sha256 } from "../server/storage.js";
import { importRepository } from "../server/importer.js";
import {
  repositoryRoot,
  dataDirectory,
  sampleWorkspaceRoot,
} from "../server/paths.js";
import {
  prepareBundle,
  validateBundle,
  draftPath,
  writeDraftArtifact,
} from "../server/bundles.js";
const run = promisify(execFile);
const usage = `Usage: npm run verify:release -- [--use-env] [--help]

By default this writes only to a disposable copy of sample-workspace and ignores
JOB_SEARCH_ROOT and JOB_SEARCH_DATA. --use-env explicitly opts into those paths
(and may write to their Store); both variables must be set.
JOB_SEARCH_VERIFICATION_REPORT selects the report path. Otherwise the report is
kept in the OS temporary directory, outside the deleted fixture workspace.`;
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
if (args.some((arg) => arg !== "--use-env")) throw new Error(usage);
const useEnv = args.includes("--use-env");
if (useEnv && (!process.env.JOB_SEARCH_ROOT || !process.env.JOB_SEARCH_DATA))
  throw new Error("--use-env requires JOB_SEARCH_ROOT and JOB_SEARCH_DATA");
// Inherited workspace settings are not consent to mutate an applicant's Store.
const scratch = useEnv
  ? undefined
  : mkdtempSync(path.join(tmpdir(), "fieldwork-release-"));
const root = scratch ? path.join(scratch, "workspace") : repositoryRoot;
if (scratch) cpSync(sampleWorkspaceRoot, root, { recursive: true });
const reportPath = process.env.JOB_SEARCH_VERIFICATION_REPORT
  ? path.resolve(process.env.JOB_SEARCH_VERIFICATION_REPORT)
  : path.join(tmpdir(), `fieldwork-verification-${randomUUID()}.json`);
const store = new Store(
  root,
  scratch ? path.join(scratch, "data") : dataDirectory,
);
try {
  const imported = await importRepository(root, undefined, () =>
    store.settings(),
  );
  store.import(imported);
  const id = randomUUID();
  const task: any = {
    id,
    title: "Verification fixture: isolated resume revision",
    preset: "resume-revision",
    prompt:
      "Fixture only: change “Experience spans” to “Technical experience spans” consistently, record the wording-only change in the isolated evidence copy, render private/public PDFs and validate. Do not change the real current master.",
    context: { documentIds: [] },
    mode: "handoff",
    status: "handoff",
    messages: [
      {
        role: "system",
        text: "Deterministic local verification fixture. No live Codex conversation was run.",
        at: now(),
      },
    ],
    events: [],
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  store.put("task", id, task);
  const prepared = prepareBundle(store, task);
  task.bundle = prepared.bundle;
  task.manifest = prepared.manifest;
  store.put("task", id, task);
  const b = prepared.bundle;
  const target = b.versionDir!;
  const html = b.paths.filter(
    (p) => p.startsWith(target + "/") && p.endsWith(".html"),
  );
  for (const relative of [b.master, `${target}/resume.md`, ...html]) {
    const file = draftPath(store, id, relative);
    const old = readFileSync(file, "utf8");
    if (!old.includes("Experience spans"))
      throw new Error(
        "Fixture source changed; review the representative edit before rerunning.",
      );
    writeDraftArtifact(
      store,
      id,
      relative,
      sha256(old),
      old.replace("Experience spans", "Technical experience spans"),
    );
  }
  const ep = draftPath(store, id, b.evidence);
  atomicWrite(
    ep,
    readFileSync(ep, "utf8") +
      `\n\n## Isolated platform verification fixture ${now()}\n\nChanged “Experience spans” to “Technical experience spans” only in this isolated draft. No accomplishments, responsibilities, technologies or metrics were added. This is a validation fixture, not an approved general-resume revision.\n`,
  );
  const stale = await validateBundle(store, id);
  if (stale.validation.status !== "failed")
    throw new Error("Stale PDFs were incorrectly accepted");
  console.log("PASS stale PDFs fail source-content validation");
  for (const relative of html) {
    const publicVersion = relative.includes("_public");
    const pdf = b.paths.find(
      (p) =>
        p.startsWith(target + "/") &&
        p.endsWith(".pdf") &&
        p.includes("_public") === publicVersion,
    )!;
    await run(
      "swift",
      [
        "-module-cache-path",
        path.join(store.dataDir, "swift-cache"),
        path.join(root, target, "render_resume.swift"),
        draftPath(store, id, relative),
        draftPath(store, id, pdf),
      ],
      { cwd: draftPath(store, id), timeout: 60000, maxBuffer: 1000000 },
    );
  }
  const valid = await validateBundle(store, id);
  if (valid.validation.status !== "passed")
    throw new Error(JSON.stringify(valid.validation, null, 2));
  console.log(
    "PASS revised Markdown, evidence, private/public HTML and two-page selectable PDFs",
  );
  const draft = draftPath(store, id, b.master);
  const expected = sha256(readFileSync(draft));
  const external =
    readFileSync(draft, "utf8") + "\n> External editor fixture\n";
  atomicWrite(draft, external);
  let rejected = false;
  try {
    writeDraftArtifact(store, id, b.master, expected, "stale overwrite");
  } catch (e: any) {
    rejected = e.status === 409;
  }
  if (!rejected || readFileSync(draft, "utf8") !== external)
    throw new Error("Concurrent draft write clobbered external content");
  // Preserve and revalidate the externally edited draft; metadata comments are ignored by the source validator.
  const finalBundle = await validateBundle(store, id);
  if (finalBundle.validation.status !== "passed")
    throw new Error("Final external-note fixture failed validation");
  store.put("task", id, {
    ...store.get("task", id)!,
    title: task.title,
    status: "completed",
    fixture: true,
    bundle: finalBundle,
    updatedAt: now(),
  });
  store.autoExport();
  const report = {
    verifiedAt: now(),
    taskId: id,
    draftDirectory: path.relative(root, draftPath(store, id)),
    liveCodex: "Not exercised by this deterministic offline fixture",
    counts: {
      companies: imported.companies.length,
      retainedOpenings: imported.openings.length,
      seenIdentities: imported.scan.seenCount,
      failedCompanies: imported.scan.failedCompanies,
      documentArtifacts: imported.documents.length,
    },
    checks: {
      stalePdfRejected: true,
      concurrentWriteRejected: true,
      currentMasterUnchanged: Object.entries(b.sourceHashes).every(
        ([p, h]) => sha256(readFileSync(path.join(root, p))) === h,
      ),
    },
    validation: finalBundle.validation,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `PASS optimistic draft conflict preserves external edit\nFixture task ${id}\nReport ${reportPath}`,
  );
} finally {
  store.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
