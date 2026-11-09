import {
  isModelRequestType,
  taskModelRequestType,
} from "../../shared/codex-models.js";
import { taskThreadIds } from "../../shared/task-threads.js";
import { parseMessageModel, resolveMessageModel } from "../message-model.js";
import { cancelOverflowRecovery } from "../preparation-overflow.js";
import { sendUserTaskMessage } from "../overflow-followup.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { strToU8, zipSync } from "fflate";
import { isTaskBusy, isTaskTurnActive } from "../../shared/types.js";
import { renderApplicationDocuments } from "../application-documents.js";
import {
  collectArtifacts,
  draftPath,
  validateBundle,
  writeDraftArtifact,
} from "../bundles.js";
import { fetchPosting } from "../job-posting.js";
import { promoteBundle } from "../promotion.js";
import {
  questionContextSummary,
  questionReferenceId,
} from "../question-context.js";
import type { WorkspaceContext } from "../server.js";
import { atomicWrite, HttpError, MissingRecordError, now } from "../storage.js";
import { hydrateTaskThread } from "../task-events.js";
import { withContext, withExportContext } from "./context.js";

function getAgentStatus(
  { agent }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  return res.json(agent.status());
}

async function getQuestionContext(
  { questionReference, store, agent }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  let error: string | null = null;
  try {
    await questionReference();
  } catch (e) {
    error = String(e);
  }
  res.json({
    ...questionContextSummary(store),
    available: agent.status().available,
    selected: agent.status().selected,
    selectionPolicy: "codex-default",
    connection: agent.status().connection,
    reason: agent.status().reason,
    referenceError: error,
  });
}

async function refreshQuestionContext(
  { questionReference, changed, store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  await questionReference(true);
  changed(res, questionContextSummary(store));
}

function getQuestionReference(
  { store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  const ref = store.get("reference_context", questionReferenceId);
  if (!ref) throw new HttpError(404, "Reference transcript has not loaded");
  res.type("text/plain").send(ref.text);
}

async function previewQuestionPosting(
  { string, store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const posting = await fetchPosting(string(req.body.url, 3000));
  const id = randomUUID();
  store.put("posting_preview", id, { id, ...posting });
  res.json({ id, ...posting });
}

async function connectAgent(
  { agent }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  try {
    await agent.connect(true);
  } catch {}
  res.json(agent.status());
}

async function createTask(
  { changed, createTask, agent, store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const model = parseMessageModel(req.body.model);
  const preset = req.body.preset;
  if (model && !isModelRequestType(preset))
    throw new HttpError(400, "Choose a task preset first.");
  const selection = model
    ? await resolveMessageModel(agent, store, preset, model)
    : {};
  return changed(
    res,
    await createTask({ ...req.body, ...selection, transientModel: !!model }),
  );
}

async function startTask(
  { changed, startSavedTask, agent, store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const model = parseMessageModel(req.body.model);
  const task = store.get("task", String(req.params.id));
  if (!task) throw new HttpError(404, "Task missing");
  const selection = model
    ? await resolveMessageModel(agent, store, taskModelRequestType(task), model)
    : {};
  return changed(
    res,
    await startSavedTask(task.id, {
      ...req.body,
      ...selection,
      transientModel: !!model,
    }),
  );
}

async function getTaskThread(
  { store, agent }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const task = store.get("task", String(req.params.id));
  if (!task) throw new HttpError(404, "Task missing");
  const threadId = String(req.params.threadId);
  if (!taskThreadIds(task).includes(threadId))
    throw new HttpError(404, "Conversation thread missing");
  res.json(await agent.read(threadId));
}

function getTaskEvents(
  { store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const task = store.get("task", String(req.params.id));
  if (!task) throw new HttpError(404, "Task missing");
  res.json({ events: store.taskEvents(task.id, { limit: 500 }) });
}

function exportTask(
  { store, taskPrompt }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const t = store.get("task", String(req.params.id));
  if (!t) throw new HttpError(404, "Task missing");
  res
    .attachment(`task-${t.id}.md`)
    .type("text/markdown")
    .send(
      `# ${t.title}\n\n${taskPrompt(t)}\n\n## Context manifest\n\n\`\`\`json\n${JSON.stringify(t.manifest, null, 2)}\n\`\`\`\n\nDraft directory: ${draftPath(store, t.id)}\n`,
    );
}

function downloadTaskBundle(
  { store, taskPrompt }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const t = store.get("task", id);
  if (!t) throw new HttpError(404, "Task missing");
  const files: Record<string, Uint8Array> = {};
  for (const a of collectArtifacts(store, id))
    files[a.path] = readFileSync(store.objectPath(a.hash));
  files["TASK.md"] = strToU8(taskPrompt(t));
  res.attachment(`task-${id}-bundle.zip`).send(Buffer.from(zipSync(files)));
}

async function resumeTask(
  { taskOperation, store, agent, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const value = await taskOperation(id, async () => {
    const t = store.get("task", id);
    if (!t) throw new MissingRecordError(404, "task", id, "Task missing");
    if (t?.documentResult?.status === "rendering")
      throw new HttpError(
        409,
        "Wait for PDF generation to finish before asking for another revision",
      );
    if (!t?.threadId)
      throw new HttpError(
        400,
        "This task has no Codex thread to resume; start its saved context or export the handoff.",
      );
    const result = await agent.resume(t.threadId);
    const detail = await agent.read(t.threadId);
    const latest = store.get("task", id);
    if (!latest) throw new MissingRecordError(404, "task", id, "Task missing");
    const updated = hydrateTaskThread(
      latest,
      detail.thread,
      now(),
      store.taskSelectionEvents(id),
    );
    const pending = agent
      .status()
      .pendingRequests.filter((r: any) => r.threadId === t.threadId);
    if (pending.length) {
      updated.pendingRequests = pending;
      updated.status = /Approval/.test(pending[0].method)
        ? "waiting for approval"
        : "waiting for input";
    }
    store.put("task", id, { ...updated, version: latest.version + 1 });
    return { task: store.get("task", id), result };
  });
  changed(res, value);
}

async function messageTask(ctx: WorkspaceContext, req: Request, res: Response) {
  const { string, changed } = ctx;
  const id = String(req.params.id);
  const prompt = string(req.body.prompt, 60000).trim();
  if (!prompt) throw new HttpError(400, "Write a follow-up first");
  const requestId =
    req.body.clientRequestId === undefined
      ? randomUUID()
      : string(req.body.clientRequestId, 100);
  const value = await sendUserTaskMessage(
    ctx,
    id,
    prompt,
    requestId,
    parseMessageModel(req.body.model),
  );
  changed(res, value);
}

async function interruptTask(
  { store, agent, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const t = store.get("task", id);
  if (!t) throw new MissingRecordError(404, "task", id, "Task missing");
  if (!t.threadId) throw new HttpError(400, "No live thread");
  cancelOverflowRecovery(store, id);
  const result = await agent.interrupt(t.threadId);
  changed(res, result);
}

async function respondToTask(
  { store, agent, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const t = store.get("task", id);
  if (!t) throw new MissingRecordError(404, "task", id, "Task missing");
  if (!t.threadId) throw new HttpError(400, "No live thread");
  const pending = agent
    .status()
    .pendingRequests.find(
      (r: any) => String(r.requestId ?? r.id) === String(req.body.requestId),
    );
  if (
    !pending ||
    !pending.threadId ||
    !taskThreadIds(t).includes(pending.threadId)
  )
    throw new HttpError(403, "Approval does not belong to this task");
  const result = await agent.respond(req.body.requestId, req.body.response);
  changed(res, result ?? { ok: true });
}

async function validateTask(
  { changed, store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  return changed(res, await validateBundle(store, String(req.params.id)));
}

async function renderTask(
  { store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const task = store.get("task", id);
  if (!task) throw new HttpError(404, "Task missing");
  const event = store
    .taskEvents(task.id)
    .reverse()
    .find(
      (e: any) =>
        e.method === "turn/completed" && e.params?.turn?.status === "completed",
    );
  const turnId = task.documentResult?.turnId ?? event?.params!.turn!.id;
  if (!turnId)
    throw new HttpError(409, "No completed document source turn is available");
  changed(res, await renderApplicationDocuments(store, id, turnId));
}

async function promoteTask(
  { store, reindex, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const task = store.get("task", id);
  if (task?.fixture)
    throw new HttpError(
      400,
      "Verification fixtures cannot become the current resume. Create a real revision task.",
    );
  if (isTaskBusy(task?.status))
    throw new HttpError(
      409,
      "Finish or interrupt the agent turn before promoting its draft",
    );
  const result = promoteBundle(store, id, req.body.expectedSourceHashes);
  await reindex();
  changed(res, result);
}

function attachTaskArtifacts(
  { store, documents, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  const task = store.get("task", id);
  if (!task) throw new HttpError(404, "Task missing");
  const prior = store.get("bundle", id);
  if (!prior)
    throw new MissingRecordError(
      409,
      "bundle",
      id,
      "The task draft bundle is missing.",
    );
  const chosen = documents(req.body.documentIds);
  const returned = [...(task.returnedArtifacts ?? [])];
  for (const d of chosen) {
    if (returned.some((a: any) => a.documentId === d.id)) continue;
    const relative = `returned-artifacts/${d.hash.slice(0, 16)}-${path.basename(d.name || d.path)}`;
    atomicWrite(
      draftPath(store, id, relative),
      readFileSync(store.objectPath(d.hash)),
    );
    returned.push({
      documentId: d.id,
      path: relative,
      sourcePath: d.path,
      hash: d.hash,
      privacy: d.privacy,
      at: now(),
    });
  }
  const bundle = {
    ...prior,
    status: "draft",
    validation: null,
    artifacts: collectArtifacts(store, id),
  };
  store.put("bundle", id, bundle);
  store.put("task", id, {
    ...task,
    returnedArtifacts: returned,
    bundle,
    updatedAt: now(),
  });
  store.journal(
    "task_artifacts",
    "Associated returned document versions with task",
    id,
    { documentIds: chosen.map((d) => d.id) },
  );
  changed(res, store.get("task", id));
}

function updateTaskArtifact(
  { store, changed, string }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const task = store.get("task", String(req.params.id));
  if (task?.preset === "questions")
    throw new HttpError(403, "Question context snapshots are read-only");
  if (
    task?.documentResult?.status === "rendering" ||
    isTaskTurnActive(task?.status)
  )
    throw new HttpError(
      409,
      "Wait for the active turn and PDF generation before editing sources",
    );
  changed(
    res,
    writeDraftArtifact(
      store,
      String(req.params.id),
      string(req.body.path, 1000),
      string(req.body.expectedHash, 64),
      string(req.body.content, 2000000),
    ),
  );
}

function getTaskArtifact(
  { store, string }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const t = store.get("task", String(req.params.id));
  if (!t) throw new HttpError(404, "Task missing");
  const p = draftPath(store, t.id, string(req.query.path, 1000));
  if (!/\.(md|html|txt|pdf|json)$/.test(p))
    throw new HttpError(403, "Unsupported artifact format");
  if (p.endsWith(".pdf")) {
    res.type("application/pdf");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    return res.sendFile(p, { dotfiles: "allow" });
  }
  res.type("text/plain").send(readFileSync(p));
}

function registerQuestions(app: Express, ctx: WorkspaceContext) {
  app.get("/api/questions/context", withContext(ctx, getQuestionContext));
  app.post(
    "/api/questions/context/refresh",
    withContext(ctx, refreshQuestionContext),
  );
  app.get("/api/questions/reference", withContext(ctx, getQuestionReference));
  app.post("/api/questions/posting", withContext(ctx, previewQuestionPosting));
}

function registerDetails(app: Express, ctx: WorkspaceContext) {
  app.get("/api/tasks/:id/events", withContext(ctx, getTaskEvents));
  app.get("/api/tasks/:id/export", withExportContext(ctx, exportTask));
  app.get("/api/tasks/:id/bundle", withExportContext(ctx, downloadTaskBundle));
  app.post("/api/tasks/:id/resume", withContext(ctx, resumeTask));
  app.get("/api/tasks/:id/threads/:threadId", withContext(ctx, getTaskThread));
  app.post("/api/tasks/:id/message", withContext(ctx, messageTask));
  app.post("/api/tasks/:id/interrupt", withContext(ctx, interruptTask));
  app.post("/api/tasks/:id/respond", withContext(ctx, respondToTask));
  app.post("/api/tasks/:id/validate", withContext(ctx, validateTask));
  app.post("/api/tasks/:id/render", withContext(ctx, renderTask));
  app.post("/api/tasks/:id/promote", withContext(ctx, promoteTask));
  app.post("/api/tasks/:id/artifacts", withContext(ctx, attachTaskArtifacts));
  app.put("/api/tasks/:id/artifact", withContext(ctx, updateTaskArtifact));
  app.get("/api/tasks/:id/artifact", withContext(ctx, getTaskArtifact));
}

export function register(
  app: Express,
  ctx: WorkspaceContext,
  phase: "status" | "questions" | "connect" | "create" | "start" | "details",
) {
  if (phase === "status")
    return app.get("/api/agent/status", withContext(ctx, getAgentStatus));
  if (phase === "questions") return registerQuestions(app, ctx);
  if (phase === "connect")
    return app.post("/api/agent/connect", withContext(ctx, connectAgent));
  if (phase === "create")
    return app.post("/api/tasks", withContext(ctx, createTask));
  if (phase === "start")
    return app.post("/api/tasks/:id/start", withContext(ctx, startTask));
  registerDetails(app, ctx);
}
