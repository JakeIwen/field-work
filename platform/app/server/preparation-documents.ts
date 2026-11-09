import { tunable } from "./tunables.js";
import { tunables } from "../shared/tunables.js";
import { cachedRead } from "./storage-read-cache.js";
import { documentWritingWarning } from "./document-writing-status.js";
import { readFileSync } from "node:fs";
import { Store, HttpError, safeSource, sha256 } from "./storage.js";
import { canonicalPosting } from "./job-posting.js";
import { applicationEvidencePaths } from "./application-evidence.js";
import {
  applicationDocumentKinds,
  type ApplicationDocumentKind,
} from "../shared/application-preparation.js";
import type { AutofillRecord } from "../shared/greenhouse-autofill.js";

export const maxAttachmentBytes =
  tunables["autofill.attachmentLimitMiB"].default * 1024 * 1024;
/** PDF bytes small enough for the autofill helper to attach. */
export const attachablePdf = (bytes: Buffer, limit = maxAttachmentBytes) =>
  bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length <= limit;
export function documentPostingHash(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(422, "Posting facts could not be verified.");
  const api = value as Record<string, unknown>;
  return sha256(
    JSON.stringify(
      api.provider === "lever" || api.provider === "ashby"
        ? {
            // Version 2 binds typed compensation; nothing shipped under version 1.
            version: 2,
            provider: api.provider,
            board: api.board,
            postingId: api.postingId,
            title: api.title,
            company: api.company,
            content: api.content,
            location: api.location,
            compensation: api.compensation ?? null,
          }
        : {
            title: api.title,
            company: api.company_name,
            content: api.content,
            location: api.location,
          },
    ),
  );
}
export function documentOpeningHash(opening: any) {
  return sha256(
    JSON.stringify({
      url: canonicalPosting(opening.url),
      title: opening.title,
      company: opening.company,
      description: opening.description || opening.requirements || "",
      location: opening.location,
      compensation: opening.compensation,
    }),
  );
}
export function preparationDocument(
  store: Store,
  openingId: string,
  documentId: string,
  postingHash?: string,
) {
  return cachedRead(
    store,
    JSON.stringify(["preparationDocument", openingId, documentId, postingHash]),
    () => readPreparationDocument(store, openingId, documentId, postingHash),
  );
}
function readPreparationDocument(
  store: Store,
  openingId: string,
  documentId: string,
  postingHash?: string,
) {
  const doc = store.document(documentId),
    opening = store.opening(openingId);
  if (
    !doc ||
    !opening ||
    doc.openingId !== openingId ||
    doc.privacy !== "private" ||
    doc.format !== "pdf" ||
    !["resume", "cover-letter"].includes(doc.kind) ||
    doc.validation !== "passed" ||
    doc.status === "rejected"
  )
    throw new HttpError(
      409,
      "A prepared document is not a validated private PDF for this Opening.",
    );
  const task =
    typeof doc.generatedBy === "string"
      ? store.taskSummaries(doc.generatedBy)[0]
      : undefined;
  const completed =
    (doc.generatedTurnId && task?.documentRuns?.[doc.generatedTurnId]) ||
    task?.documentResult;
  if (
    !task ||
    task.context?.openingId !== openingId ||
    completed?.status !== "ready" ||
    !completed.documentIds?.includes(doc.id)
  )
    throw new HttpError(
      409,
      "Document generation or validation is incomplete.",
    );
  if (postingHash && task.preparationPostingHash !== postingHash)
    throw new HttpError(
      409,
      "The current job posting differs from the document context. Refresh preparation.",
    );
  if (
    task.preparationOpeningHash
      ? task.preparationOpeningHash !== documentOpeningHash(opening)
      : canonicalPosting(task.posting?.url || "") !==
          canonicalPosting(opening.url) ||
        task.posting?.hash !==
          sha256(opening.description || opening.requirements || "")
  )
    throw new HttpError(
      409,
      "The posting changed since these documents were generated.",
    );
  const hashes =
    task.bundle?.sourceHashes ??
    store.get("bundle", task.id)?.sourceHashes ??
    {};
  for (const file of applicationEvidencePaths) {
    if (
      !hashes[file] ||
      sha256(readFileSync(safeSource(store.root, file))) !== hashes[file]
    )
      throw new HttpError(
        409,
        `Resume evidence changed: ${file.endsWith("github_evidence_dossier.md") ? "the supporting experience dossier" : "the resume source"} was updated. Prepare current documents.`,
      );
  }
  const bytes = readFileSync(store.objectPath(doc.hash));
  if (
    typeof doc.name !== "string" ||
    /[/\\\0]/.test(doc.name) ||
    !/\.pdf$/i.test(doc.name) ||
    sha256(bytes) !== doc.hash ||
    !attachablePdf(
      bytes,
      tunable(store, "autofill.attachmentLimitMiB") * 1024 * 1024,
    )
  )
    throw new HttpError(
      409,
      "A prepared PDF is missing, corrupted, or too large to attach.",
    );
  return { doc, bytes };
}
export function reusableDocuments(
  store: Store,
  openingId: string,
  postingHash?: string,
  completingTaskId?: string,
) {
  const completing = completingTaskId
    ? (store.taskSummaries(completingTaskId)[0]?.documentResult?.documentIds ??
      [])
    : [];
  const found = new Map<string, any>();
  for (const doc of store
    .list("generated_document")
    .filter((d) => d.openingId === openingId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    if (found.has(doc.kind)) continue;
    try {
      // Finish an already-running task under its captured policy. Future runs
      // regenerate affected kinds; existing files remain available for review.
      if (!completing.includes(doc.id) && documentWritingWarning(store, doc))
        continue;
      found.set(
        doc.kind,
        preparationDocument(store, openingId, doc.id, postingHash).doc,
      );
    } catch {
      /* Stale/missing artifacts are regenerated. */
    }
  }
  return applicationDocumentKinds.flatMap((kind) =>
    found.has(kind) ? [found.get(kind)] : [],
  );
}

/**
 * The kinds a run should generate for a saved script. A cover letter is
 * skipped when the inspected form has no cover-letter upload slot (owner decision,
 * 2026-11-08). The resume is always generated: it is still downloadable, and
 * the attachment packager reports a missing resume slot itself. Scripts saved
 * before `documentSlots` existed say nothing about the form, so they keep both.
 */
export function scriptDocumentKinds(
  record: Pick<AutofillRecord, "documentSlots">,
): ApplicationDocumentKind[] {
  const slots = record.documentSlots;
  if (!slots) return [...applicationDocumentKinds];
  return applicationDocumentKinds.filter(
    (kind) => kind === "resume" || slots.includes(kind),
  );
}
