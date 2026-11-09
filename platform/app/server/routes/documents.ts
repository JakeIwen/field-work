import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { diffLines } from "diff";
import { resumeVariantReport } from "../reports.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError, safeSource } from "../storage.js";
import {
  applyDocumentRetention,
  previewDocumentRetention,
} from "../document-retention.js";
import { withContext } from "./context.js";

function compareDocuments(
  { store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const a = store.document(String(req.query.a));
  const b = store.document(String(req.query.b));
  if (!a || !b) throw new HttpError(404, "Document not found");
  if (!a.text?.trim() || !b.text?.trim())
    throw new HttpError(
      422,
      "Readable text is unavailable for one of these artifacts. Preview the PDFs directly; no content comparison was computed.",
    );
  res.json({ a, b, changes: diffLines(a.text, b.text) });
}

function setDocumentStatus(
  { store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const d = store.document(String(req.params.id));
  if (!d || d.hash !== req.body.expectedHash)
    throw new HttpError(409, "Document changed");
  if (req.body.status !== "preferred" || d.status === "rejected")
    throw new HttpError(
      400,
      "Only an eligible preferred package version can be selected here; master changes require a validated revision",
    );
  const old = store.get("personal", d.id) ?? { version: 0 };
  const value = store.update("personal", d.id, old.version, {
    preferred: true,
  });
  store.journal(
    "document_preferred",
    "Selected a preferred document for the next package",
    d.id,
  );
  changed(res, value);
}

function serveDocument(
  { store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const d = store.document(String(req.params.id));
  if (!d) throw new HttpError(404, "Document not found");
  if (!["file", "download", "source"].includes(String(req.params.action)))
    throw new HttpError(404, "Unknown document action");
  if (req.params.action === "source") {
    if (!d.sourceHash)
      throw new HttpError(404, "No captured source for this document");
    return res
      .type("text/plain")
      .sendFile(store.objectPath(d.sourceHash), { dotfiles: "allow" });
  }
  const p = store.objectPath(d.hash);
  if (!existsSync(p))
    throw new HttpError(404, "Immutable document copy missing");
  if (req.params.action === "download") {
    store.flushExport();
    res.attachment(path.basename(d.name || d.path));
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    return res.sendFile(p, { dotfiles: "allow" });
  }
  if (d.format === "pdf") {
    res.type("application/pdf");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${path.basename(d.name || d.path).replaceAll('"', "")}"`,
    );
    return res.sendFile(p, { dotfiles: "allow" });
  }
  res
    .type("text/plain")
    .send(
      d.text ?? "No readable text available. Download the original artifact.",
    );
}

function serveSource(
  { root, store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const generated = store
    .list("generated_document")
    .find((d) => d.path === req.query.path);
  if (generated)
    return res.redirect(
      `/api/documents/${encodeURIComponent(generated.id)}/file`,
    );
  const p = safeSource(root, String(req.query.path ?? ""));
  if (p.endsWith(".pdf")) {
    const document = store
      .list("cache_document")
      .find((d) => d.path === req.query.path && d.availableInSource !== false);
    if (document)
      return res.redirect(
        `/api/documents/${encodeURIComponent(document.id)}/file`,
      );
  }
  if (!/\.(md|txt|json|html)$/.test(p))
    throw new HttpError(403, "This source is not readable text");
  res.type("text/plain").send(readFileSync(p, "utf8"));
}

function reportResumeVariants(
  { store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json(resumeVariantReport(store));
}

function previewRetention(
  { store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json(previewDocumentRetention(store));
}

function runRetention(
  { store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json(applyDocumentRetention(store));
}

export function register(
  app: Express,
  ctx: WorkspaceContext,
  phase: "documents" | "reports",
) {
  if (phase === "reports") {
    app.get(
      "/api/reports/resume-variants",
      withContext(ctx, reportResumeVariants),
    );
    return;
  }
  app.get("/api/documents/compare", withContext(ctx, compareDocuments));
  app.get("/api/documents/retention", withContext(ctx, previewRetention));
  app.post("/api/documents/retention", withContext(ctx, runRetention));
  app.post("/api/documents/:id/status", withContext(ctx, setDocumentStatus));
  app.get("/api/documents/:id/:action", withContext(ctx, serveDocument));
  app.get("/api/source", withContext(ctx, serveSource));
}
