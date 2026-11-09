import { registerOpeningFormChecks } from "./opening-form-checks.js";
import { registerOpeningApplication } from "./opening-application.js";
import { savedAutofillHistory } from "../autofill/validity.js";
import { readFileSync } from "node:fs";
import type { Express, Request, Response } from "express";
import { zipSync } from "fflate";
import {
  postingIdentity,
  samePostingIdentity,
} from "../../shared/posting-url.js";
import { preparationActivity } from "../preparation-activity.js";
import { autofillActivity } from "../../shared/greenhouse-autofill.js";
import { hostedApplication } from "../../shared/application-host.js";
import { reviewApplicationAnswer } from "../application-answers.js";
import { recordAutofillCopy } from "../autofill/copy.js";
import { savedAutofills, savedAutofillScript } from "../greenhouse-autofill.js";
import { postingUrl } from "../job-posting.js";
import { canonicalPosting, findOpeningByUrl } from "../opening-workflow.js";
import { preparationDocument } from "../preparation-documents.js";
import {
  preparationDocumentKinds,
  preparationDocumentsSaved,
  type ApplicationDocumentKind,
} from "../../shared/application-preparation.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";
import { withContext, withExportContext } from "./context.js";

async function importOpening(
  {
    store,
    string,
    changed,
    openingOperation,
    taskActive,
    createTask,
  }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const url = postingUrl(string(req.body.url, 3000)).href;
  changed(
    res,
    await openingOperation(`import:${canonicalPosting(url)}`, async () => {
      const identity = postingIdentity(url);
      const byUrl = findOpeningByUrl(store, url);
      const existing =
        byUrl ??
        (identity.jobId
          ? store.openings().find((o) => {
              try {
                return samePostingIdentity(identity, postingIdentity(o.url));
              } catch {
                return false;
              }
            })
          : undefined);
      if (existing) {
        const { validation: _validation, ...record } = existing;
        store.put("custom_opening", existing.id, {
          ...record,
          personalOpening: true,
        });
        const matchedBy = byUrl ? "url" : "jobId";
        if (matchedBy === "jobId")
          store.journal(
            "opening_import_matched",
            `Imported URL matched existing ${existing.company} · ${existing.title} by requisition`,
            existing.id,
            { url, matchedBy, identity },
          );
        return { openingId: existing.id, existing: true, matchedBy };
      }
      const active = store
        .list("task")
        .find(
          (t) =>
            t.preset === "opening-research" &&
            t.importUrl &&
            canonicalPosting(t.importUrl) === canonicalPosting(url) &&
            taskActive(t),
        );
      if (active) return active;
      return createTask({
        preset: "opening-research",
        prompt: `Research and add ${url}`,
        importUrl: url,
        mode: "live",
        clientRequestId: req.body.clientRequestId,
      });
    }),
  );
}

async function generateOpeningDocuments(
  {
    store,
    changed,
    openingOperation,
    taskActive,
    createTask,
  }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  changed(
    res,
    await openingOperation(`documents:${id}`, async () => {
      const opening = store.opening(id);
      if (!opening) throw new HttpError(404, "Opening not found");
      const prior = store
        .list("task")
        .filter(
          (t) =>
            t.preset === "posting-application" && t.context?.openingId === id,
        )
        .at(-1);
      if (
        prior &&
        (taskActive(prior) ||
          (!req.body.regenerate && prior.documentResult?.status === "ready"))
      )
        return prior;
      return createTask({
        preset: "posting-application",
        mode: "live",
        prompt:
          "Generate my tailored resume and cover letter for this opening. Review both against my evidence and writing guidelines.",
        context: { openingId: id, companyId: opening.company_id },
        postingUrl: opening.url,
        postingLabel: `${opening.company} ${opening.title}`,
        clientRequestId: req.body.clientRequestId,
      });
    }),
  );
}

async function askOpeningQuestion(
  { store, changed, createTask }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const opening = store.opening(String(req.params.id));
  if (!opening) throw new HttpError(404, "Opening not found");
  changed(
    res,
    await createTask({
      preset: "questions",
      mode: "live",
      prompt: req.body.question,
      context: { openingId: opening.id, companyId: opening.company_id },
      postingUrl: opening.url,
      postingLabel: `${opening.company} ${opening.title}`,
      clientRequestId: req.body.clientRequestId,
    }),
  );
}

function getOpeningAutofill(
  { store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  res.json(
    req.query.history === "1"
      ? savedAutofillHistory(store, String(req.params.id))
      : savedAutofills(store, String(req.params.id), req.query.latest === "1"),
  );
}

function getOpeningAutofillStatus(
  { store, openingOperations }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  if (!store.opening(id)) throw new HttpError(404, "Opening not found");
  res.json(
    autofillActivity(
      openingOperations.has(`autofill:${id}`),
      store.taskSummaries(undefined, id),
    ),
  );
}

function getOpeningPreparation(
  { store, preparation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  if (!store.opening(id)) throw new HttpError(404, "Opening not found");
  res.json(preparation!.latest(id) ?? null);
}

function getOpeningPreparationActivity(
  { store, preparation, agent }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  if (!store.opening(id)) throw new HttpError(404, "Opening not found");
  res.json(
    preparationActivity(
      {
        latestRecord: (openingId) => preparation!.latestRecord(openingId),
        getTask: (taskId) => store.get("task", taskId),
        liveActivity: (threadId) => agent.liveActivity(threadId),
      },
      id,
    ),
  );
}

function prepareOpening(
  { changed, preparation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  changed(
    res,
    preparation!.start(
      String(req.params.id),
      req.body.documentKind,
      req.body.scope,
    ),
  );
}

function downloadPreparationDocuments(
  { store, preparation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const run = preparation!.latest(String(req.params.id));
  if (!run || run.scope === "answers" || run.status !== "ready" || run.stale)
    throw new HttpError(
      409,
      "Prepare current documents before downloading the package.",
    );
  const docs = run.documentIds.map((id) =>
    preparationDocument(store, run.openingId, id),
  );
  res
    .type("application/zip")
    .attachment("application-documents.zip")
    .send(
      Buffer.from(
        zipSync(
          Object.fromEntries(docs.map(({ doc, bytes }) => [doc.name, bytes])),
        ),
      ),
    );
}

// Saves a current script, then drafts any questions it still lacks; a drafting
// failure is reported on the saved script rather than discarding it.
async function generateAutofillWithAnswers(
  {
    generatePreparedAutofill,
    startAutofillAnswers,
  }: Pick<
    WorkspaceContext,
    "generatePreparedAutofill" | "startAutofillAnswers"
  >,
  id: string,
) {
  const saved = await generatePreparedAutofill(id);
  try {
    const task = await startAutofillAnswers(saved);
    return { ...saved, ...(task ? { answerTaskId: task.id } : {}) };
  } catch (error) {
    return { ...saved, answerError: String(error) };
  }
}

async function generateOpeningAutofill(
  ctx: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const record = await ctx.openingOperation(`autofill:${id}`, () =>
    generateAutofillWithAnswers(ctx, id),
  );
  ctx.changed(res, record);
}

async function regenerateAutofillAnswers(
  {
    store,
    changed,
    openingOperation,
    startAutofillAnswers,
    generatePreparedAutofill,
  }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const { record } = savedAutofillScript(
    store,
    String(req.params.id),
    String(req.params.scriptId),
  );
  changed(
    res,
    await openingOperation(`autofill:${record.openingId}`, async () => {
      const refreshed = await generatePreparedAutofill(record.openingId);
      const task = await startAutofillAnswers(refreshed, true);
      return { ...refreshed, ...(task ? { answerTaskId: task.id } : {}) };
    }),
  );
}

async function reviewAutofillAnswer(
  ctx: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  ctx.changed(
    res,
    await ctx.openingOperation(`autofill:${id}`, async () => {
      reviewApplicationAnswer(
        ctx.store,
        id,
        String(req.params.taskId),
        String(req.params.key),
        req.body,
      );
      // A review saved from a stale script yields a script whose other
      // questions may need drafting again under current evidence.
      return generateAutofillWithAnswers(ctx, id);
    }),
  );
}

function recordOpeningAutofillCopy(
  { store, changed, preparation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const run = preparation?.latest(String(req.params.id));
  if (run && ["queued", "running", "waiting"].includes(run.status))
    throw new HttpError(
      409,
      "Preparation is still running. Wait for the complete package before copying it.",
    );
  changed(
    res,
    recordAutofillCopy(
      store,
      String(req.params.id),
      String(req.params.scriptId),
    ),
  );
}

function getOpeningAutofillScript(
  { store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const { record, script } = savedAutofillScript(
    store,
    String(req.params.id),
    String(req.params.scriptId),
  );
  if (req.query.download === "1") {
    store.flushExport();
    const provider = hostedApplication(record.url)?.provider ?? "greenhouse";
    res.attachment(`${provider}-autofill-v${record.version}.js`);
  }
  res.type("text/plain").send(script);
}

/** Documents of the Opening's latest finished document task, for Openings with no usable preparation run. */
function completedTaskDocumentIds(
  store: WorkspaceContext["store"],
  openingId: string,
  required: readonly ApplicationDocumentKind[],
): string[] {
  // A form without a cover-letter slot expects only the resume, whose
  // regeneration runs as its own posting-resume task.
  const presets: string[] =
    required.length > 1
      ? ["posting-application"]
      : ["posting-application", "posting-resume"];
  const task = store
    .list("task")
    .filter(
      (t) =>
        presets.includes(t.preset) &&
        t.context?.openingId === openingId &&
        t.documentResult?.status === "ready",
    )
    .at(-1);
  if (!task) throw new HttpError(404, "No completed application documents yet");
  return task.documentResult!.documentIds!;
}

function downloadOpeningDocuments(
  { store, preparation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const run = preparation?.latestRecord(String(req.params.id));
  const required = preparationDocumentKinds(run ?? {});
  const docs = (
    run && preparationDocumentsSaved(run)
      ? // The run's validated selection, so a PDF it left out (an older letter on a no-slot form) is not packaged.
        run.documentIds
      : completedTaskDocumentIds(store, String(req.params.id), required)
  )
    .map((id: string) => store.document(id))
    .filter((d: any) => d?.privacy === "private");
  if (!required.every((kind) => docs.some((d: any) => d.kind === kind)))
    throw new HttpError(
      409,
      required.length > 1
        ? "Both application documents must finish first"
        : "The resume must finish first",
    );
  res
    .type("application/zip")
    .attachment(
      `application-${String(req.params.id).replace(/[^a-z0-9-]/gi, "-")}.zip`,
    )
    .send(
      Buffer.from(
        zipSync(
          Object.fromEntries(
            docs.map((d: any) => [
              d.name,
              readFileSync(store.objectPath(d.hash)),
            ]),
          ),
        ),
      ),
    );
}

export function register(
  app: Express,
  ctx: WorkspaceContext,
  phase: "opening" | "preparation",
) {
  if (phase === "opening") {
    registerOpeningFormChecks(app, ctx);
    registerOpeningApplication(app, ctx);
    app.post("/api/openings/import", withContext(ctx, importOpening));
    app.post(
      "/api/openings/:id/generate",
      withContext(ctx, generateOpeningDocuments),
    );
    app.post(
      "/api/openings/:id/questions",
      withContext(ctx, askOpeningQuestion),
    );
    app.get("/api/openings/:id/autofill", withContext(ctx, getOpeningAutofill));
    app.get(
      "/api/openings/:id/autofill/status",
      withContext(ctx, getOpeningAutofillStatus),
    );
    return;
  }
  app.get(
    "/api/openings/:id/preparation",
    withContext(ctx, getOpeningPreparation),
  );
  app.get(
    "/api/openings/:id/preparation/activity",
    withContext(ctx, getOpeningPreparationActivity),
  );
  app.post("/api/openings/:id/prepare", withContext(ctx, prepareOpening));
  app.get(
    "/api/openings/:id/preparation/documents",
    withExportContext(ctx, downloadPreparationDocuments),
  );
  app.post(
    "/api/openings/:id/autofill",
    withContext(ctx, generateOpeningAutofill),
  );
  app.post(
    "/api/openings/:id/autofill/:scriptId/answers",
    withContext(ctx, regenerateAutofillAnswers),
  );
  app.post(
    "/api/openings/:id/autofill/answers/:taskId/:key/review",
    withContext(ctx, reviewAutofillAnswer),
  );
  app.post(
    "/api/openings/:id/autofill/:scriptId/copied",
    withContext(ctx, recordOpeningAutofillCopy),
  );
  app.get(
    "/api/openings/:id/autofill/:scriptId",
    withContext(ctx, getOpeningAutofillScript),
  );
  app.get(
    "/api/openings/:id/documents",
    withExportContext(ctx, downloadOpeningDocuments),
  );
}
