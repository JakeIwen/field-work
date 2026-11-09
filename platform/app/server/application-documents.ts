import { currentResumePath } from "../shared/workspace-sources.js";
import { tunableMs } from "./tunables.js";
import { diagnosticLog } from "./diagnostic-log.js";
import { overflowPublicationFailure } from "./overflow-recovery-ownership.js";
import {
  assertOverflowRecoveryActive,
  assertOverflowPublicationFresh,
} from "./preparation-overflow.js";
import {
  runDocumentRenderer,
  rendererOverflowResult,
} from "./renderer-overflow.js";
import { capturedDocumentWritingRules } from "./document-writing-status.js";
import {
  applyDocumentRetention,
  documentRetentionOwner,
} from "./document-retention.js";
import type { ApplicationDocumentKind } from "../shared/application-preparation.js";
import { renderApplicationResume } from "./application-resume.js";
import {
  documentFilename,
  cleanDocumentLabel,
  applicationDocumentNamingVersion,
} from "./document-names.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  assertGenerationActive,
  beginGeneration,
} from "./generation-control.js";
import { remoteRenderConfigured } from "./remote-render-client.js";
import {
  Store,
  HttpError,
  MissingRecordError,
  sha256,
  now,
  atomicWrite,
} from "./storage.js";
import { draftPath, collectArtifacts, checkSources } from "./bundles.js";
import { postingDocumentPresets } from "./question-context.js";
import type { Document } from "../shared/types.js";
import type {
  BundleValidation,
  ValidationCheck,
} from "../shared/task-records.js";

const running = new Set<string>();
type CompleteValidation = BundleValidation & { checks: ValidationCheck[] };
const coverRenderer = fileURLToPath(
  new URL("../scripts/render-cover-letter.swift", import.meta.url),
);
export { documentFilename } from "./document-names.js";
function documentFailureDetails(error: unknown) {
  return {
    ...rendererOverflowResult(error),
    ...overflowPublicationFailure(error),
  };
}

export async function renderApplicationDocuments(
  store: Store,
  id: string,
  turnId: string,
): Promise<import("../shared/task-records.js").DocumentResult> {
  if (running.has(id))
    throw new HttpError(409, "PDF generation is already running");
  let task = store.get("task", id);
  if (!task) throw new MissingRecordError(404, "task", id, "Task missing");
  if (!postingDocumentPresets.includes(task.preset))
    throw new HttpError(
      400,
      "This task does not generate posting-specific documents",
    );
  if (task.documentRuns?.[turnId]?.status === "ready")
    return task.documentRuns[turnId];
  if (task.status === "running" || task.status === "queued")
    throw new HttpError(409, "Wait for Codex to finish the document sources");
  if (process.platform !== "darwin" && !remoteRenderConfigured())
    throw new HttpError(503, "The trusted PDF renderers require macOS");
  const bundle = store.get("bundle", id);
  if (!bundle)
    throw new MissingRecordError(
      409,
      "bundle",
      id,
      "The task draft bundle is missing. Restore it before generating PDFs.",
    );
  assertOverflowRecoveryActive(store, id, turnId);
  const finishGeneration = beginGeneration(store);
  running.add(id);
  try {
    store.put("task", id, {
      ...task,
      documentResult: { status: "rendering", turnId, startedAt: now() },
    });
    const conflicts = checkSources(store, bundle, true);
    if (conflicts.length)
      throw new HttpError(
        409,
        `Original sources changed since the draft began: ${conflicts.map((c) => c.path).join(", ")}. Start a new document draft with current sources.`,
      );
    const inputHashes = Object.fromEntries(
      collectArtifacts(store, id)
        .filter(
          (a) =>
            /\.(md|txt|html|json)$/.test(a.path) &&
            !a.path.startsWith("exports/"),
        )
        .map((a) => [a.path, a.hash]),
    );
    const at = now();
    const label = cleanDocumentLabel(
      task.postingLabel || task.posting?.title || "job-posting",
    );
    const generated: Document[] = [];
    const writingRules = capturedDocumentWritingRules(store, task, bundle);
    const capture = (
      bytes: Buffer,
      privacy: string,
      text: string,
      sourcePath: string,
      kind: ApplicationDocumentKind,
    ) => {
      const name = documentFilename(label, kind, privacy, at, turnId);
      const relative = `exports/${name}`;
      atomicWrite(draftPath(store, id, relative), bytes);
      const hash = sha256(bytes);
      atomicWrite(store.objectPath(hash), bytes);
      const sourceBytes = readFileSync(draftPath(store, id, sourcePath));
      const sourceHash = sha256(sourceBytes);
      atomicWrite(store.objectPath(sourceHash), sourceBytes);
      const document = {
        sourceHash,
        id: `generated-${sha256(`${id}:${turnId}:${kind}:${privacy}`).slice(0, 24)}:${hash.slice(0, 20)}`,
        logicalId: `posting-${sha256(`${task.posting!.hash}:${kind}:${privacy}`).slice(0, 20)}`,
        name,
        namingVersion: applicationDocumentNamingVersion,
        ...(writingRules?.[kind]
          ? { writingRuleHash: writingRules[kind] }
          : {}),
        path: path.relative(store.root, draftPath(store, id, relative)),
        hash,
        kind,
        scope: "tailored",
        company: task.postingLabel
          ? cleanDocumentLabel(task.postingLabel)
          : null,
        version: at.slice(0, 10),
        versionNumber: 0,
        status: "draft",
        privacy,
        format: "pdf",
        authoredDate: at.slice(0, 10),
        dateProvenance:
          "Generated from this explicit application-document task; UTC creation timestamp recorded separately.",
        createdAt: at,
        modifiedAt: at,
        firstImportedAt: at,
        text,
        sourcePath,
        generatedBy: id,
        openingId: task.context?.openingId ?? null,
        applicationId: task.context?.applicationId ?? null,
        generatedTurnId: turnId,
        postingUrl: task.posting?.url ?? null,
        postingLabel: label,
        availableInSource: false,
        origin: "generated",
        validation: "passed",
      };
      generated.push(document);
    };
    let validation: CompleteValidation | undefined;
    if (
      task.preset === "posting-cover-letter" ||
      task.preset === "posting-application"
    ) {
      const letterPath = draftPath(store, id, "cover_letter.txt");
      if (!existsSync(letterPath))
        throw new HttpError(
          422,
          "Codex did not create cover_letter.txt. Ask it to finish the source file, then retry PDFs.",
        );
      const letter = readFileSync(letterPath, "utf8").trim();
      if (!letter || letter.length > 12000)
        throw new HttpError(422, "Cover letter is empty or too long");
      const expected = sha256(letter);
      const output = draftPath(store, id, "rendered-cover-letter.pdf");
      const result = await runDocumentRenderer(
        store,
        "cover-letter",
        "swift",
        [
          "-module-cache-path",
          path.join(store.dataDir, "swift-cache"),
          coverRenderer,
          letterPath,
          draftPath(store, id, currentResumePath),
          output,
        ],
        {
          timeout: tunableMs(store, "documents.renderTimeoutS"),
          maxBuffer: 1000000,
        },
      );
      if (sha256(readFileSync(letterPath, "utf8").trim()) !== expected)
        throw new HttpError(
          409,
          "Letter changed during rendering; retry the PDF generation",
        );
      validation = {
        status: "passed",
        at: now(),
        checks: [
          {
            name: "One-page cover letter and complete selectable text",
            status: "passed",
            output: result.stdout + result.stderr,
          },
        ],
      };
      capture(
        readFileSync(output),
        "private",
        letter,
        "cover_letter.txt",
        "cover-letter",
      );
    }
    if (task.preset !== "posting-cover-letter") {
      const resume = await renderApplicationResume(store, id, bundle);
      validation = {
        ...resume.validation,
        checks: [...(validation?.checks ?? []), ...resume.validation.checks],
      };
      capture(
        resume.bytes,
        "private",
        resume.text,
        resume.sourcePath,
        "resume",
      );
    }
    for (const [relative, hash] of Object.entries(inputHashes)) {
      if (sha256(readFileSync(draftPath(store, id, relative))) !== hash)
        throw new HttpError(
          409,
          `Draft source changed during rendering: ${relative}. No generated document was registered; review the edit and retry.`,
        );
    }
    assertGenerationActive(store);
    const result = {
      status: "ready",
      turnId,
      createdAt: at,
      documentIds: generated.map((d) => d.id),
      validation,
    };
    const latestTask = store.get("task", id);
    if (!latestTask)
      throw new MissingRecordError(404, "task", id, "Task missing");
    const latestBundle = store.get("bundle", id);
    if (!latestBundle)
      throw new MissingRecordError(
        409,
        "bundle",
        id,
        "The task draft bundle was removed during PDF generation.",
      );
    assertOverflowPublicationFresh(store, task, bundle, turnId);
    store.transaction(() => {
      for (const d of generated) store.put("generated_document", d.id, d);
      const application =
        task.context?.applicationId &&
        store.get("application", task.context.applicationId);
      if (application && !application.submittedAt) {
        const kinds = new Set<string | undefined>(generated.map((d) => d.kind));
        const retained = application.documentIds.filter(
          (docId: string) => !kinds.has(store.document(docId)?.kind),
        );
        store.put("application", application.id, {
          ...application,
          documentIds: [
            ...retained,
            ...generated
              .filter((d) => d.privacy === "private")
              .map((d) => d.id),
          ],
          version: application.version + 1,
          updatedAt: now(),
        });
      }
      store.put("task", id, {
        ...latestTask,
        documentResult: result,
        documentRuns: { ...(latestTask.documentRuns ?? {}), [turnId]: result },
        updatedAt: now(),
      });
    });
    store.put("bundle", id, {
      ...latestBundle,
      artifacts: collectArtifacts(store, id),
      validation,
    });
    try {
      applyDocumentRetention(store, generated.map(documentRetentionOwner));
    } catch (error) {
      // Pruning older versions must never undo a successful generation.
      diagnosticLog(
        "error",
        "application-documents",
        "Generated document retention failed",
        {},
        error,
      );
      store.journal(
        "document_retention_failed",
        `Older generated documents were kept: ${error instanceof Error ? error.message : String(error)}`,
        id,
      );
    }
    store.autoExport();
    return result;
  } catch (error: any) {
    const latest = store.get("task", id);
    if (!latest)
      throw error instanceof MissingRecordError && error.kind === "task"
        ? error
        : new MissingRecordError(404, "task", id, "Task missing");
    const result = {
      ...documentFailureDetails(error),
      status: "failed",
      turnId,
      error:
        error.stdout || error.stderr
          ? `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`
          : error.message,
    };
    store.put("task", id, {
      ...latest,
      documentResult: result,
      updatedAt: now(),
    });
    store.journal("application_document_error", "PDF generation failed", id, {
      error: result.error,
    });
    store.autoExport();
    if (error instanceof MissingRecordError) throw error;
    return result;
  } finally {
    running.delete(id);
    finishGeneration();
  }
}
