import { tunablesPath } from "../../shared/tunables.js";
import { saveTunables } from "./tunables-settings.js";
import { clientSecurityHeaders } from "../client-security.js";
import { currentFormQuestionCounts } from "../autofill/form-check-state.js";
import { preparationSettingsPath } from "../../shared/preparation-settings.js";
import { savePreparationSettings } from "./preparation-settings.js";
import {
  deleteTheme,
  saveActiveTheme,
  saveTheme,
} from "./appearance-settings.js";
import { createBackupArchive } from "../backup-archive.js";
import { stateResponseJson } from "../state-response-json.js";
import { resumeSkills } from "../resume-skills.js";
import { withReadCache } from "../storage-read-cache.js";
import { documentsWithWritingWarnings } from "../document-writing-status.js";
import { remainingWorkspaceWork } from "../workspace-activity.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { sendStateJson } from "../state-encoding.js";
import Negotiator from "negotiator";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { normalizeFitCriteria } from "../../shared/fit-criteria.js";
import { normalizeSchedules } from "../../shared/schedules.js";
import { syncCompanyContacts } from "../company-contacts.js";
import { withNextRuns } from "../scheduler.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError, now, sha256 } from "../storage.js";
import { withContext } from "./context.js";
import { followUpSummaries } from "../follow-up-email.js";
import { openingAutofillCounts } from "../autofill/validity.js";
import type { AppHealth } from "../../shared/app-reload.js";

function guardRequest(
  { port, csrfToken, reloader, options }: WorkspaceContext,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  if (options.cloudAccess) {
    hosts.add(new URL(options.cloudAccess.publicOrigin).host);
    origins.add(options.cloudAccess.publicOrigin);
  }
  if (!hosts.has(req.headers.host ?? ""))
    return res
      .status(403)
      .json({ error: "Host is not the configured loopback address" });
  const origin = req.headers.origin;
  if (origin && !origins.has(origin))
    return res
      .status(403)
      .json({ error: "Cross-origin requests are forbidden" });
  // Permit links to the app shell without opening API or embedded requests.
  // The Host and Origin checks above and write-CSRF checks below still apply.
  const isEntryNavigation =
    req.method === "GET" &&
    (req.path === "/" || req.path === "/api/gmail/callback") &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    req.headers["sec-fetch-dest"] === "document";
  if (req.headers["sec-fetch-site"] === "cross-site" && !isEntryNavigation)
    return res.status(403).json({ error: "Cross-site requests are forbidden" });
  clientSecurityHeaders(res);
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers["x-csrf-token"] !== csrfToken
  )
    return res.status(403).json({
      code: "CSRF_TOKEN_INVALID",
      error: "Missing or invalid CSRF token",
    });
  if (
    reloader.active &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    !["/api/system/reload", "/api/system/stop"].includes(req.path)
  )
    return res
      .status(503)
      .json({ error: "The app is reloading. Retry when it is ready." });
  next();
}

function getSession(
  { csrfToken }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json({ csrfToken });
}

function getCareersScans(
  { careers }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json(careers.state());
}

function startOpeningValidation(
  { string, openingValidation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const openingId =
    req.body.openingId === undefined
      ? undefined
      : string(req.body.openingId, 300);
  if (openingId === "")
    throw new HttpError(400, "Opening ID must not be empty");
  res.status(202).json(openingValidation.start(openingId));
}

function resumeOpeningValidation(
  { openingValidation }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.status(202).json(openingValidation.resume());
}

async function startCareersScan(
  { string, reindex, careers }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  if (!["all", "failed"].includes(req.body.mode))
    throw new HttpError(400, "Choose all monitored or failed companies");
  const requestId = string(req.body.clientRequestId, 100);
  if (!requestId) throw new HttpError(400, "A request ID is required");
  await reindex();
  res.status(202).json(careers.start(req.body.mode, requestId));
}

function pauseCareersScan(
  { careers }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  return res.json(careers.pause(String(req.params.id)));
}

function resumeCareersScan(
  { careers }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  return res.status(202).json(careers.resume(String(req.params.id)));
}

function getHealth(
  { reloader }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json({
    status: "ok",
    pid: process.pid,
    reloading: reloader.active,
    reload: reloader.status(),
  } satisfies AppHealth);
}

function reloadSystem(
  { reloader }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  if (req.body.whenIdle !== undefined && typeof req.body.whenIdle !== "boolean")
    throw new HttpError(400, "whenIdle must be a boolean");
  res.status(202).json(reloader.request(req.body.whenIdle === true));
}

function stopSystem(
  { options, reloader }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  if (!options.shutdown)
    throw new HttpError(503, "This embedded server does not expose shutdown");
  res.json({ stopping: true });
  if (!reloader.active) setTimeout(options.shutdown, 25);
}

function getState(
  {
    store,
    preparation,
    greenhousePull,
    openingValidation,
    indexing,
    reindexProgress,
  }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  res.vary("Accept-Encoding");
  const supported = ["br", "gzip", "identity"];
  // Negotiator 1.1 supports this overload; its published types still omit it.
  const negotiation: {
    encoding(
      available: string[],
      options: { preferred: string[] },
    ): string | undefined;
  } = new Negotiator(req);
  const encoding = negotiation.encoding(supported, { preferred: supported });
  if (!encoding) {
    res.status(406).end();
    return;
  }
  const json = withReadCache(store, () => {
    const snapshot = store.state();
    const preparations = preparation?.state() ?? [];
    return stateResponseJson(snapshot, {
      knownSkills: resumeSkills(store),
      openingFormChecks: currentFormQuestionCounts(store),
      documents: documentsWithWritingWarnings(
        store,
        snapshot.documents,
        snapshot.tasks,
      ),
      followUps: followUpSummaries(store),
      preparations,
      ...openingAutofillCounts(store, preparations),
      greenhousePull: greenhousePull?.state() ?? null,
      openingValidation: openingValidation.state(),
      indexing: !!indexing,
      reindexProgress,
    });
  });
  return sendStateJson(res, store, json, encoding);
}

function streamEvents(
  { streams }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive" });
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  streams.add(res);
  const pulse = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  req.on("close", () => {
    clearInterval(pulse);
    streams.delete(res);
  });
}

async function reindexWorkspace(
  { reindex }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json(await reindex());
}

function updatePersonal(
  { pick, string, date, store, version, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const fields = pick(req.body, [
    "saved",
    "dismissed",
    "reviewedHash",
    "notes",
    "interest",
    "nextAction",
    "followUp",
    "monitoring",
  ]);
  if ("monitoring" in fields) fields.pendingWatchlist = false;
  for (const key of ["saved", "dismissed", "monitoring"])
    if (key in fields && typeof fields[key] !== "boolean")
      throw new HttpError(400, `${key} must be boolean`);
  for (const key of ["reviewedHash", "notes", "interest", "nextAction"])
    if (key in fields) string(fields[key]);
  if ("followUp" in fields) date(fields.followUp);
  const previous = store.get("personal", String(req.params.id));
  const changedFields = Object.entries(fields)
    .filter(
      ([key, value]) =>
        key !== "reviewedHash" &&
        key !== "pendingWatchlist" &&
        value !== previous?.[key as keyof NonNullable<typeof previous>],
    )
    .map(([key]) => key);
  const value = store.update(
    "personal",
    String(req.params.id),
    version(req.body.expectedVersion),
    fields,
  );
  if (changedFields.length)
    store.journal(
      "personal_updated",
      `Updated personal fields: ${changedFields.join(", ")}`,
      String(req.params.id),
      { fields: changedFields },
    );
  changed(res, value);
}

function createCompany(
  { string, store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const name = string(req.body.name, 200).trim();
  const careersUrl = string(req.body.careersUrl, 2000);
  if (!name || !/^https?:\/\//.test(careersUrl))
    throw new HttpError(400, "Company name and HTTP(S) careers URL required");
  const id = `personal-${randomUUID()}`;
  const c = {
    id,
    name,
    sourcePath: "App-owned employer",
    sourceDate: null,
    fields: { "Careers URL": careersUrl },
    text: string(req.body.notes ?? ""),
    hash: sha256(name + careersUrl),
    addedAt: now(),
    personalCompany: true,
  };
  store.put("custom_company", id, c);
  syncCompanyContacts(store);
  store.journal("company_added", `Added ${name} to personal watchlist`, id);
  changed(res, c);
}

function updateSettings(
  { store, string, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const body = req.body ?? {};
  if (!["timezone", "schedules", "fitCriteria"].some((k) => k in body))
    throw new HttpError(400, "Provide timezone, schedules or fitCriteria");
  const old = store.settings();
  const next: any = { ...old };
  if ("timezone" in body) {
    const timezone = string(body.timezone, 100);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new HttpError(400, "Unknown IANA timezone");
    }
    next.timezone = timezone;
  }
  if ("schedules" in body) {
    if (
      !body.schedules ||
      typeof body.schedules !== "object" ||
      Array.isArray(body.schedules)
    )
      throw new HttpError(400, "schedules must be an object");
    const requested = normalizeSchedules(body.schedules);
    // The scheduler owns lastStartedAt; a settings form never rewinds or forges it.
    // normalizeSchedules returns only the known schedule keys used to index both records.
    for (const key of Object.keys(requested) as (keyof typeof requested)[])
      requested[key].lastStartedAt = old.schedules[key].lastStartedAt;
    next.schedules = requested;
  }
  if ("fitCriteria" in body) {
    if (
      !body.fitCriteria ||
      typeof body.fitCriteria !== "object" ||
      Array.isArray(body.fitCriteria)
    )
      throw new HttpError(400, "fitCriteria must be an object");
    next.fitCriteria = {
      ...normalizeFitCriteria(body.fitCriteria),
      version: old.fitCriteria.version + 1,
    };
  }
  next.schedules = withNextRuns(next.schedules);
  next.version = (old.version ?? 0) + 1;
  changed(res, store.put("settings", "main", next));
}

function createFilter(
  { string, store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const name = string(req.body.name, 100);
  if (!req.body.filters || typeof req.body.filters !== "object")
    throw new HttpError(400, "Filter definition missing");
  const id = randomUUID();
  changed(
    res,
    store.put("filter", id, {
      id,
      name,
      filters: req.body.filters,
      createdAt: now(),
    }),
  );
}

function downloadBackup(
  { store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  const { bytes, integrity } = createBackupArchive(store);
  // Keep headers bounded even when many objects are lost; full IDs are in the ZIP.
  res.set(
    "X-Backup-Integrity",
    JSON.stringify({
      ok: integrity.ok,
      missing: integrity.missingObjects.length,
      mismatched: integrity.mismatchedObjects.length,
      unreadable: integrity.unreadableObjects.length,
      manifest: "backup-integrity.json",
    }),
  );
  return res
    .attachment(`job-search-backup-${now().slice(0, 10)}.zip`)
    .send(Buffer.from(bytes));
}

function apiNotFound(_req: Request, res: Response) {
  return res.status(404).json({ error: "Unknown application route" });
}

function guardStaticFiles(
  { staticDir }: WorkspaceContext,
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const directory = staticDir;
  if (!existsSync(directory)) return next();
  if (lstatSync(directory).isSymbolicLink())
    throw new HttpError(403, "Static build directory cannot be a symlink");
  const canonical = realpathSync(directory);
  let relative: string;
  try {
    relative = decodeURIComponent(req.path);
  } catch {
    throw new HttpError(400, "Invalid URL encoding");
  }
  const target = path.resolve(canonical, "." + relative);
  if (target !== canonical && !target.startsWith(canonical + path.sep))
    throw new HttpError(403, "Static path leaves build directory");
  if (existsSync(target)) {
    const resolved = realpathSync(target);
    if (resolved !== canonical && !resolved.startsWith(canonical + path.sep))
      throw new HttpError(403, "Static symlink leaves build directory");
    if (lstatSync(resolved).isDirectory()) {
      const index = path.join(resolved, "index.html");
      if (
        existsSync(index) &&
        !realpathSync(index).startsWith(canonical + path.sep)
      )
        throw new HttpError(403, "Static index symlink leaves build directory");
    }
  }
  next();
}

function serveClient(
  { staticDir }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  if (!existsSync(path.join(staticDir, "index.html")))
    res
      .status(503)
      .type("text")
      .send("Build the client with npm run build, then reload.");
  else res.sendFile(path.join(staticDir, "index.html"));
}

function handleError(err: any, _req: Request, res: Response, _next: any) {
  res
    .status(err.status ?? 500)
    .json({ error: err.message ?? "Unexpected local server error" });
}

function registerInitial(app: Express, ctx: WorkspaceContext) {
  app.disable("x-powered-by");
  app.use((req, res, next) => guardRequest(ctx, req, res, next));
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/session", withContext(ctx, getSession));
  app.get("/api/careers-scans", withContext(ctx, getCareersScans));
  app.post("/api/opening-validation", withContext(ctx, startOpeningValidation));
  app.post(
    "/api/opening-validation/resume",
    withContext(ctx, resumeOpeningValidation),
  );
  app.post("/api/careers-scans", withContext(ctx, startCareersScan));
  app.post("/api/careers-scans/:id/pause", withContext(ctx, pauseCareersScan));
  app.post(
    "/api/careers-scans/:id/resume",
    withContext(ctx, resumeCareersScan),
  );
  app.get("/api/health", withContext(ctx, getHealth));
  app.get("/api/system/activity", (_req, res) =>
    res.json({ remaining: remainingWorkspaceWork(ctx) }),
  );
  app.post("/api/system/stop", withContext(ctx, stopSystem));
  app.post("/api/system/reload", withContext(ctx, reloadSystem));
  app.get(
    "/api/system/reload",
    withContext(ctx, ({ reloader }, _req, res) => res.json(reloader.status())),
  );
  app.post(
    "/api/system/reload/cancel",
    withContext(ctx, ({ reloader }, _req, res) => res.json(reloader.cancel())),
  );
  app.get("/api/state", withContext(ctx, getState));
  app.get("/api/events", withContext(ctx, streamEvents));
  app.post("/api/reindex", withContext(ctx, reindexWorkspace));
}

function registerPersonal(app: Express, ctx: WorkspaceContext) {
  app.post("/api/personal/:id", withContext(ctx, updatePersonal));
  app.post("/api/companies", withContext(ctx, createCompany));
}

function registerClient(app: Express, ctx: WorkspaceContext) {
  app.use("/api", apiNotFound);
  app.use((req, res, next) => guardStaticFiles(ctx, req, res, next));
  app.use(
    express.static(ctx.staticDir, {
      index: "index.html",
      dotfiles: "deny",
    }),
  );
  app.get("/", withContext(ctx, serveClient));
  app.use(handleError);
}

export function register(
  app: Express,
  ctx: WorkspaceContext,
  phase: "initial" | "personal" | "settings" | "preferences" | "client",
) {
  if (phase === "initial") return registerInitial(app, ctx);
  if (phase === "personal") return registerPersonal(app, ctx);
  if (phase === "settings") {
    app.post("/api/settings", withContext(ctx, updateSettings));
    app.post(tunablesPath, withContext(ctx, saveTunables));
    app.post("/api/settings/palette", withContext(ctx, saveActiveTheme));
    app.post("/api/settings/themes", withContext(ctx, saveTheme));
    app.delete("/api/settings/themes/:id", withContext(ctx, deleteTheme));
    app.post(
      preparationSettingsPath,
      withContext(ctx, savePreparationSettings),
    );
    return;
  }
  if (phase === "preferences") {
    app.post("/api/filters", withContext(ctx, createFilter));
    app.get("/api/backup", withContext(ctx, downloadBackup));
    return;
  }
  registerClient(app, ctx);
}
