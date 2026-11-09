import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { Document } from "../../shared/types.js";
import { sha256 } from "../storage.js";
import {
  classifyDocument,
  isImportableDocumentPath,
  MASTER_PATH,
  SOURCE_README,
  type DocumentClassification,
} from "./classify-documents.js";
import {
  authoredDate,
  currentVersion,
  currentTailoredDirectories,
  privateDocumentPaths,
  htmlText,
  isLegacyResumeDocument,
  letterDate,
} from "./document-content.js";
import {
  errorMessage,
  issue,
  readSafe,
  textOptional,
  walk,
  type ReadContext,
} from "./read-context.js";

import { norm } from "./text.js";

type NotesReader = (relative: string) => Promise<string>;
type DocumentSource = {
  buffer: Buffer;
  info: Awaited<ReturnType<typeof stat>>;
  raw: string;
  classification: DocumentClassification;
  text: string;
};
type DocumentMetadata = {
  notesPath: string;
  notes: string;
  date: string | null;
  datePath: string;
};

async function discoverDocumentPaths(
  ctx: ReadContext,
): Promise<{ selected: string[]; valid: boolean }> {
  ctx.onProgress?.({ phase: "discovery" });
  const paths: string[] = [];
  let valid = true;
  for (const dir of [
    "source_master_template",
    "employer_specific",
    "old_resume",
  ]) {
    try {
      paths.push(...(await walk(ctx, dir)));
    } catch (error) {
      valid = false;
      issue(
        ctx,
        "error",
        "document-import",
        `Document directory could not be read: ${dir}: ${errorMessage(error)}`,
        [dir],
      );
    }
  }
  try {
    for (const file of await readdir(path.join(ctx.root, "source_data")))
      if (`source_data/${file}` === MASTER_PATH) paths.push(MASTER_PATH);
  } catch (error) {
    valid = false;
    issue(
      ctx,
      "error",
      "document-import",
      `Content masters could not be read: ${errorMessage(error)}`,
      ["source_data"],
    );
  }
  return { selected: paths.filter(isImportableDocumentPath), valid };
}

async function readDocumentSource(
  ctx: ReadContext,
  relative: string,
  version: string | null,
  sourceReadme: string,
  getNotes: NotesReader,
): Promise<DocumentSource> {
  const buffer = await readSafe(ctx, relative);
  const info = await stat(path.join(ctx.root, relative));
  const detectedFormat = path.extname(relative).slice(1).toLowerCase();
  const raw = /^(md|txt|html)$/.test(detectedFormat)
    ? buffer.toString("utf8")
    : "";
  const employerDirectory = /^employer_specific\/[^/]+(?=\/)/.exec(
    relative,
  )?.[0];
  const privacyPaths = employerDirectory
    ? privateDocumentPaths(
        await getNotes(`${employerDirectory}/README.md`),
        employerDirectory,
      )
    : [];
  const classification = classifyDocument({
    relative,
    raw,
    currentVersion: version,
    privateDocumentPaths: privacyPaths,
    currentTailoredDirectories: currentTailoredDirectories(sourceReadme),
  });
  const text = classification.format === "html" ? htmlText(raw) : raw;
  return { buffer, info, raw, classification, text };
}

async function resolveDocumentMetadata(
  relative: string,
  version: string | null,
  source: DocumentSource,
  getNotes: NotesReader,
): Promise<DocumentMetadata> {
  const { kind, fallbackNotesPath, discardNotes } = source.classification;
  let notesPath = source.classification.initialNotesPath;
  let notes = notesPath ? await getNotes(notesPath) : "";
  if (!notes && fallbackNotesPath) {
    notesPath = fallbackNotesPath;
    notes = await getNotes(notesPath);
  }
  // A later note does not establish authorship of an archived pre-update copy.
  if (discardNotes) {
    notes = "";
    notesPath = "";
  }
  let date =
      authoredDate(source.raw) ??
      (kind === "cover-letter" ? letterDate(source.text) : null),
    datePath = relative;
  if (!date && notes) {
    date = authoredDate(notes);
    datePath = notesPath;
  }
  if (!date && relative === MASTER_PATH && version) {
    datePath = `source_master_template/${version}/revision_notes.md`;
    date = authoredDate(await getNotes(datePath));
  }
  return { notesPath, notes, date, datePath };
}

function buildDocument(
  relative: string,
  source: DocumentSource,
  metadata: DocumentMetadata,
): Document {
  const {
    base,
    format,
    scope,
    company,
    versionLabel,
    versionNumber,
    kind,
    privacy,
    status,
    bundleId,
    statusProvenance,
    privacyProvenance,
  } = source.classification;
  const hash = sha256(source.buffer),
    logicalId = `doc-${sha256(relative).slice(0, 20)}`;
  return {
    id: `${logicalId}:${hash.slice(0, 20)}`,
    logicalId,
    path: relative,
    hash,
    name: base,
    kind,
    scope,
    company,
    version: versionLabel,
    versionNumber,
    status,
    privacy,
    format,
    authoredDate: metadata.date,
    dateProvenance: metadata.date
      ? `Explicit revision/authorship statement in ${metadata.datePath}; date only`
      : "Unknown. Filesystem modification time is not an authorship date.",
    modifiedAt: source.info.mtime.toISOString(),
    text: source.text,
    ...(metadata.notes
      ? { notesPath: metadata.notesPath, revisionNotes: metadata.notes }
      : {}),
    bundleId,
    statusProvenance,
    privacyProvenance,
  };
}

async function readDocument(
  ctx: ReadContext,
  relative: string,
  version: string | null,
  getNotes: NotesReader,
): Promise<Document> {
  const source = await readDocumentSource(
    ctx,
    relative,
    version,
    await getNotes(SOURCE_README),
    getNotes,
  );
  const metadata = await resolveDocumentMetadata(
    relative,
    version,
    source,
    getNotes,
  );
  return buildDocument(relative, source, metadata);
}

async function importSelectedDocuments(
  ctx: ReadContext,
  selected: string[],
  version: string | null,
  documents: Document[],
  getNotes: NotesReader,
  initialValid: boolean,
): Promise<boolean> {
  let valid = initialValid;
  let completed = 0;
  ctx.onProgress?.({ phase: "documents", completed, total: selected.length });
  for (const relative of selected) {
    try {
      documents.push(await readDocument(ctx, relative, version, getNotes));
    } catch (error) {
      valid = false;
      issue(
        ctx,
        "error",
        "document-import",
        `Document import failed: ${relative}: ${errorMessage(error)}`,
        [relative],
      );
    } finally {
      ctx.onProgress?.({
        phase: "documents",
        completed: ++completed,
        total: selected.length,
      });
    }
  }
  return valid;
}

function applyDocumentReferences(doc: Document, documents: Document[]): void {
  const related = documents.filter(
    (other) => other.bundleId === doc.bundleId && other.kind === doc.kind,
  );
  doc.relatedIds = related
    .filter((other) => other.id !== doc.id)
    .map((other) => other.id);
  if (doc.privacy === "unknown" && doc.format === "pdf") {
    const source = related.find(
      (other) => other.format === "html" && other.privacy === "private",
    );
    if (source && !/_public/i.test(doc.name)) {
      doc.privacy = "private";
      doc.privacyProvenance = `Private HTML sibling ${source.path}; public variants have explicit filenames`;
    }
  }
  if (!doc.text && doc.format === "pdf") {
    const sibling =
      related.find(
        (other) => other.format === "html" && other.privacy === doc.privacy,
      ) ??
      related.find((other) => other.format === "txt" || other.format === "md");
    if (sibling) {
      doc.text = sibling.text;
      doc.textSourcePath = sibling.path;
      doc.textProvenance = "Readable source sibling, not extracted PDF text";
    }
  }
  if (!doc.authoredDate && doc.kind === "cover-letter") {
    const datedSource = related.find(
      (other) => other.authoredDate && ["html", "txt"].includes(other.format),
    );
    if (datedSource) {
      doc.authoredDate = datedSource.authoredDate;
      doc.dateProvenance = `Explicit letter dateline in source sibling ${datedSource.path}; date only`;
    }
  }
  if (doc.scope === "general" && doc.versionNumber > 0) {
    const previousVersion = Math.max(
      0,
      ...documents
        .filter(
          (other) =>
            other.scope === "general" &&
            other.versionNumber < doc.versionNumber &&
            other.status !== "rejected",
        )
        .map((other) => other.versionNumber),
    );
    doc.previousVersionIds = documents
      .filter(
        (other) =>
          other.scope === "general" &&
          other.versionNumber === previousVersion &&
          other.format === doc.format &&
          other.privacy === doc.privacy,
      )
      .map((other) => other.id);
  }
}

function checkMasterConsistency(
  ctx: ReadContext,
  documents: Document[],
  version: string | null,
): void {
  const master = documents.find((d) => d.path === MASTER_PATH);
  const snapshot = documents.find(
    (d) => d.path === `source_master_template/${version}/resume.md`,
  );
  if (master && snapshot && norm(master.text) !== norm(snapshot.text))
    issue(
      ctx,
      "error",
      "conflicting-master",
      "The current general Markdown master differs from its declared version snapshot. Neither file was overwritten; reconcile with the evidence dossier and resume validator.",
      [master.path, snapshot.path],
    );
}

function checkDocumentMetadata(
  ctx: ReadContext,
  documents: Document[],
  version: string | null,
): void {
  const reportable = documents.filter(
    (d) => !isLegacyResumeDocument(d.path, version),
  );
  const unknownDates = reportable.filter((d) => !d.authoredDate);
  if (unknownDates.length)
    issue(
      ctx,
      "info",
      "unknown-dates",
      `${unknownDates.length} documents have no verified authored/revised date. Modification times remain separate.`,
      unknownDates.map((d) => d.path),
    );
  const unknownPrivacy = reportable.filter((d) => d.privacy === "unknown");
  if (unknownPrivacy.length)
    issue(
      ctx,
      "warning",
      "unknown-privacy",
      `${unknownPrivacy.length} legacy artifacts have unverified privacy status; inspect before export.`,
      unknownPrivacy.map((d) => d.path),
    );
}

function substantiveText(text: string): string {
  return norm(
    text
      .replace(/(?:\+?1[- .]?)?\(?\d{3}\)?[- .]\d{3}[- .]\d{4}/g, "")
      .replace(/[•|]/g, " "),
  );
}

function checkCurrentResumeBundle(
  ctx: ReadContext,
  bundle: string | undefined,
  documents: Document[],
): void {
  const members = documents.filter(
    (d) => d.bundleId === bundle && d.kind === "resume",
  );
  for (const format of ["html", "pdf"]) {
    if (
      !members.some((d) => d.format === format && d.privacy === "private") ||
      !members.some((d) => d.format === format && d.privacy === "public")
    ) {
      issue(
        ctx,
        "warning",
        "missing-variant",
        `Current resume bundle ${bundle} lacks a verified private/public ${format.toUpperCase()} pair.`,
        members.map((d) => d.path),
      );
    }
  }
  const privateHtml = members.find(
    (d) => d.format === "html" && d.privacy === "private",
  );
  const publicHtml = members.find(
    (d) => d.format === "html" && d.privacy === "public",
  );
  if (
    privateHtml &&
    publicHtml &&
    substantiveText(privateHtml.text) !== substantiveText(publicHtml.text)
  )
    issue(
      ctx,
      "error",
      "variant-content-conflict",
      `Private/public text differs beyond phone omission in ${bundle}. Run the repository source validator before using this bundle.`,
      [privateHtml.path, publicHtml.path],
    );
}

function checkCurrentResumeBundles(
  ctx: ReadContext,
  documents: Document[],
): void {
  for (const bundle of new Set(
    documents
      .filter((d) => d.kind === "resume" && d.status === "current")
      .map((d) => d.bundleId),
  ))
    checkCurrentResumeBundle(ctx, bundle, documents);
}

async function checkLocalNoteLinks(
  ctx: ReadContext,
  cache: Map<string, string>,
): Promise<void> {
  // Report actual local source-link problems without touching the network or archived ZIP contents.
  for (const [notesPath, notes] of cache) {
    for (const match of notes.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(notesPath), target),
      );
      try {
        await stat(path.join(ctx.root, relative));
      } catch {
        issue(
          ctx,
          "warning",
          "broken-link",
          `A document note links to a missing local file: ${target}`,
          [notesPath, relative],
        );
      }
    }
    if (/`(?:\.\.\/)+tmp\//.test(notes)) {
      try {
        await stat(path.join(ctx.root, "tmp"));
      } catch {
        issue(
          ctx,
          "warning",
          "broken-link",
          "Historical notes reference the removed tmp directory. These sources were not recreated.",
          [notesPath],
        );
      }
    }
  }
}

export async function importDocuments(
  ctx: ReadContext,
  sourceReadme: string,
): Promise<{ documents: Document[]; valid: boolean }> {
  const discovered = await discoverDocumentPaths(ctx);
  const documents: Document[] = [];
  const version = currentVersion(sourceReadme);
  if (!version)
    issue(
      ctx,
      "error",
      "current-master",
      "The current general resume version could not be established from the source README. No highest-numbered version was promoted.",
      [SOURCE_README],
    );
  const cache = new Map<string, string>();
  const getNotes = async (p: string) => {
    if (!cache.has(p)) cache.set(p, await textOptional(ctx, p));
    return cache.get(p)!;
  };
  const valid = await importSelectedDocuments(
    ctx,
    discovered.selected,
    version,
    documents,
    getNotes,
    discovered.valid,
  );
  ctx.onProgress?.({ phase: "references" });
  for (const doc of documents) applyDocumentReferences(doc, documents);
  checkMasterConsistency(ctx, documents, version);
  checkDocumentMetadata(ctx, documents, version);
  checkCurrentResumeBundles(ctx, documents);
  await checkLocalNoteLinks(ctx, cache);
  documents.sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "general" ? -1 : 1) ||
      b.versionNumber - a.versionNumber ||
      a.path.localeCompare(b.path),
  );
  return { documents, valid };
}
