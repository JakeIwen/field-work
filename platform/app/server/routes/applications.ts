import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { strToU8, zipSync } from "fflate";
import type { ApplicationStatus } from "../../shared/types.js";
import { HttpError, now } from "../storage.js";
import type { WorkspaceContext } from "../server.js";

const applicationStatuses: ApplicationStatus[] = [
  "considering",
  "preparing",
  "ready",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];

import { withContext, withExportContext } from "./context.js";

function createApplication(
  { store, string, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const openingId = string(req.body.openingId, 300);
  if (!store.opening(openingId)) throw new HttpError(404, "Opening not found");
  const existing = store
    .list("application")
    .find((a) => a.openingId === openingId);
  if (existing) return res.json(existing);
  const id = randomUUID();
  const a: import("../../shared/types.js").Application = {
    id,
    openingId,
    status: "considering",
    nextAction: "",
    followUp: "",
    contacts: "",
    notes: "",
    documentIds: [],
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    packages: [],
  };
  store.put("application", id, a);
  store.journal(
    "application_created",
    "Started considering an application",
    id,
  );
  changed(res, a);
}

function updateApplication(
  {
    store,
    pick,
    string,
    date,
    documents,
    assertPackageReady,
    version,
    changed,
  }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const old = store.get("application", id);
  if (!old) throw new HttpError(404, "Application not found");
  const p = pick(req.body, [
    "status",
    "nextAction",
    "followUp",
    "contacts",
    "notes",
    "documentIds",
  ]);
  for (const k of ["nextAction", "contacts", "notes"]) if (k in p) string(p[k]);
  if ("followUp" in p) date(p.followUp);
  if ("status" in p) {
    if (!applicationStatuses.includes(p.status))
      throw new HttpError(400, "Invalid application status");
    if (p.status === "applied" && !old.submittedAt)
      throw new HttpError(400, "Use Mark submitted to capture exact documents");
  }
  if ("documentIds" in p)
    p.documentIds = documents(p.documentIds).map((d) => d.id);
  if ((p.status ?? old.status) === "ready")
    assertPackageReady(documents(p.documentIds ?? old.documentIds));
  const value = store.update(
    "application",
    id,
    version(req.body.expectedVersion),
    p,
  );
  store.journal("application_updated", `Application ${value.status}`, id, {
    status: value.status,
  });
  changed(res, value);
}

function submitApplication(
  { store, documents, assertPackageReady, version, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const a = store.get("application", id);
  if (!a) throw new HttpError(404, "Application missing");
  if (a.submittedAt)
    throw new HttpError(
      409,
      "Submission already recorded. Its original package is immutable.",
    );
  const docs = documents(req.body.documentIds ?? a.documentIds);
  assertPackageReady(docs);
  if (!docs.length)
    throw new HttpError(
      400,
      "Select the exact documents used before marking submitted",
    );
  const pack = {
    id: randomUUID(),
    at: now(),
    documents: docs.map((d) => ({
      id: d.id,
      path: d.path,
      name: d.name,
      hash: d.hash,
      privacy: d.privacy,
      format: d.format,
      version: d.version,
      kind: d.kind,
    })),
  };
  for (const d of docs)
    if (!existsSync(store.objectPath(d.hash)))
      throw new HttpError(
        409,
        "Immutable document copy missing; reimport or restore backup",
      );
  const value = store.update(
    "application",
    id,
    version(req.body.expectedVersion),
    {
      status: "applied",
      submittedAt: pack.at,
      documentIds: docs.map((d) => d.id),
      packages: [...(a.packages ?? []), pack],
    },
  );
  store.journal(
    "application_submitted",
    "Submission recorded with immutable document versions",
    id,
    { packageId: pack.id, documentIds: value.documentIds },
  );
  changed(res, value);
}

function exportApplication(
  { store, documents }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const a = store.get("application", String(req.params.id));
  if (!a) throw new HttpError(404, "Application missing");
  const pack = a.packages?.at(-1) ?? {
    id: "draft",
    documents: documents(a.documentIds),
    at: null,
  };
  if (!pack.documents?.length)
    throw new HttpError(
      409,
      "No documents were saved in this application package.",
    );
  const manifest = {
    schemaVersion: 1,
    applicationId: a.id,
    openingId: a.openingId,
    submittedAt: a.submittedAt ?? null,
    package: {
      id: pack.id,
      at: pack.at,
      // Submitted and draft packages share fields despite their inferred union.
      documents: pack.documents.map((d: any) => ({
        id: d.id,
        filename: path.basename(d.name || d.path),
        hash: d.hash,
        privacy: d.privacy,
        format: d.format,
        version: d.version,
      })),
    },
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  };
  // Package documents always have a name or path, so the fallback path is present.
  for (const [i, d] of pack.documents.entries())
    files[
      `${String(i + 1).padStart(2, "0")}-${d.privacy}-${path.basename(d.name || d.path!)}`
    ] = readFileSync(store.objectPath(d.hash));
  res
    .attachment(`application-${a.id}-${pack.id}.zip`)
    .send(Buffer.from(zipSync(files)));
}

export function register(app: Express, ctx: WorkspaceContext) {
  app.post("/api/applications", withContext(ctx, createApplication));
  app.patch("/api/applications/:id", withContext(ctx, updateApplication));
  app.post("/api/applications/:id/submit", withContext(ctx, submitApplication));
  app.get(
    "/api/applications/:id/export",
    withExportContext(ctx, exportApplication),
  );
}
