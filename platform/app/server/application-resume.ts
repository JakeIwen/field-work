import { tunableMs } from "./tunables.js";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { Bundle } from "../shared/task-records.js";
import { type Store, HttpError, safeSource, sha256 } from "./storage.js";
import { draftPath, collectArtifacts, validateBundle } from "./bundles.js";
import { bundleDocuments } from "./bundle-documents.js";
import { runDocumentRenderer } from "./renderer-overflow.js";
import { htmlText } from "./importer.js";

function resumeInputs(store: Store, id: string, bundle: Bundle) {
  const folder = bundle.versionDir;
  if (
    !folder ||
    !/^source_master_template\/v\d+(?:_[a-z]+)?$/.test(folder) ||
    !bundle.master
  )
    throw new HttpError(400, "No valid general resume template was captured");
  const rendererPath = `${folder}/render_resume.swift`;
  const renderer = safeSource(store.root, rendererPath);
  if (sha256(readFileSync(renderer)) !== bundle.sourceHashes[rendererPath])
    throw new HttpError(409, "The trusted renderer changed since capture");
  const selected = bundleDocuments(
    collectArtifacts(store, id),
    folder,
    bundle.master,
    true,
  );
  const document = selected.documents.find(
    (document) => document.kind === "resume",
  );
  if (selected.errors.length || !document)
    throw new HttpError(
      422,
      selected.errors.join("\n") ||
        "One private resume HTML/PDF pair is required",
    );
  if (
    !readFileSync(draftPath(store, id, `${folder}/resume.md`)).equals(
      readFileSync(draftPath(store, id, bundle.master)),
    )
  )
    throw new HttpError(
      422,
      "The version Markdown and draft master must be synchronized before rendering",
    );
  const contents = readFileSync(
    draftPath(store, id, document.privateHtml),
    "utf8",
  );
  if (/<!ENTITY|<script\b|<iframe\b|<!DOCTYPE[^>]+SYSTEM/i.test(contents))
    throw new HttpError(
      400,
      "Executable or external-entity HTML is not allowed in resume sources",
    );
  return { renderer, document };
}

/** Tailored application output contains the private resume only. */
export async function renderApplicationResume(
  store: Store,
  id: string,
  bundle: Bundle,
) {
  const { renderer, document } = resumeInputs(store, id, bundle);
  await runDocumentRenderer(
    store,
    "resume",
    "swift",
    [
      "-module-cache-path",
      path.join(store.dataDir, "swift-cache"),
      renderer,
      draftPath(store, id, document.privateHtml),
      draftPath(store, id, document.privatePdf),
    ],
    {
      timeout: tunableMs(store, "documents.renderTimeoutS"),
      maxBuffer: 1000000,
    },
  );
  const checked = await validateBundle(store, id, true);
  if (checked.validation.status !== "passed")
    throw new HttpError(
      422,
      `Resume validation failed: ${checked.validation.checks
        .filter((check) => check.status !== "passed")
        .map((check) => `${check.name}: ${check.output}`)
        .join("\n")}`,
    );
  return {
    bytes: readFileSync(draftPath(store, id, document.privatePdf)),
    text: htmlText(
      readFileSync(draftPath(store, id, document.privateHtml), "utf8"),
    ),
    sourcePath: document.privateHtml,
    validation: checked.validation,
  };
}
