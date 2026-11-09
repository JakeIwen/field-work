import { researchPrompt } from "../opening-research-policy.js";
import { withOverflowRecoveryTurn } from "../overflow-recovery-ownership.js";
import {
  completeAutofill,
  completePostingDocuments,
  completeResearch,
  type AgentEvent,
  type CompletionContext,
  type TaskEventServices,
} from "./task-completion.js";
export type { TaskEventServices } from "./task-completion.js";
import { randomUUID } from "node:crypto";
import { isTaskBusy } from "../../shared/types.js";
import { prepareBundle, collectArtifacts } from "../bundles.js";
import { fetchPosting, postingUrl } from "../job-posting.js";
import type { PullCandidate, PullRun } from "../greenhouse-pull.js";
import {
  openingResearchInstructions,
  prepareOpeningResearch,
  startOpeningApplication,
} from "../opening-workflow.js";
import type { prepareFollowUpBundle } from "../follow-up-email-task.js";
import { followUpKindConfig } from "./follow-up-kind.js";
import { creationOptionFields } from "./task-creation-fields.js";
import {
  postingDocumentPrompt,
  preparePostingDocumentBundle,
  prepareQuestionBundle,
  questionPrompt,
} from "../question-context.js";
import {
  HttpError,
  MissingRecordError,
  now,
  sha256,
  type Store,
} from "../storage.js";
import { applyTaskEvent } from "../task-events.js";
import type { Task, TaskPreset } from "../../shared/task-records.js";
import {
  taskPolicyMetadata,
  type TaskPolicyMetadata,
  type TaskPurpose,
} from "./purpose-policies.js";
import {
  applicationSourceTools,
  coverLetterSourceTools,
  noSourceTools,
  questionsSourceTools,
  researchSourceTools,
  resumeSourceTools,
  type SourceToolDispatch,
  type SourceToolPolicy,
} from "./source-tools.js";

// Retain the existing loose creation boundary; persisted tasks use Task below.
type TaskDraft = Parameters<typeof prepareBundle>[1];
type ReferenceContext = Parameters<typeof prepareQuestionBundle>[2];
type PreparedBundle =
  | ReturnType<typeof prepareBundle>
  | ReturnType<typeof prepareQuestionBundle>
  | ReturnType<typeof preparePostingDocumentBundle>
  | ReturnType<typeof prepareOpeningResearch>
  | ReturnType<typeof prepareFollowUpBundle>;

export type TaskCreationBody = TaskDraft;
export type TaskCreationOptions = {
  autofillContext?: TaskDraft["autofillContext"];
  preparationContext?: {
    id: string;
    openingHash: string;
    postingHash?: string;
    posting?: TaskDraft["posting"];
  };
  greenhouseContext?: { run: PullRun; candidate: PullCandidate };
};

export type TaskCreationServices = {
  store: Store;
  string: (value: unknown, max?: number) => string;
  pick: (body: TaskCreationBody, fields: string[]) => Task["context"];
  documents: (ids: unknown) => unknown;
  questionReference: () => Promise<ReferenceContext>;
  suppliedPosting: (body: TaskCreationBody) => Promise<TaskDraft>;
  publish: (type: string, detail?: Record<string, unknown>) => void;
  startSavedTask: (
    id: string,
    body: TaskCreationBody,
  ) => Promise<Task | undefined>;
};

type CompletionHooks = {
  afterAutofill?: (context: CompletionContext) => void;
};
type CreationSources = {
  reference: ReferenceContext | null;
  opening: ReturnType<Store["opening"]> | null;
  posting: TaskDraft;
  postingLabel: string;
};
type ValidatedCreation = {
  body: TaskCreationBody;
  preset: TaskPreset;
  kind: TaskKind;
  prompt: string;
  context: Task["context"];
  clientRequestId: string | null;
  existing?: Task;
};
export type TaskKindConfig = {
  purpose: (task: Task) => TaskPurpose | undefined;
  prepareBundle: (
    store: Store,
    task: TaskDraft,
    reference: ReferenceContext | null,
  ) => PreparedBundle;
  initialize: (
    services: TaskCreationServices,
    task: TaskDraft,
    options: TaskCreationOptions,
  ) => Promise<void> | void;
  taskFields: (
    services: TaskCreationServices,
    request: ValidatedCreation,
    sources: CreationSources,
  ) => TaskDraft;
  prompt: (task: Task) => string;
  onTurnCompleted: CompletionHooks;
  questionLike: boolean;
  requiresPosting: boolean;
  collectArtifacts: boolean;
  sourceTools: SourceToolPolicy;
};

export type TaskKind = TaskKindConfig & {
  prepare: (
    services: TaskCreationServices,
    request: ValidatedCreation,
    options: TaskCreationOptions,
  ) => Task | undefined | Promise<Task | undefined>;
  sandbox: (task: Task) => TaskPolicyMetadata["sandbox"];
  instructions: (task: Task) => string;
  tools: (task: Task) => unknown[] | undefined;
};

const noCompletionHooks: CompletionHooks = {};
const noTaskFields = () => ({});
const noInitialization = () => undefined;
const ordinaryPurpose = () => undefined;
const fixedPurpose = (purpose: TaskPurpose) => () => purpose;
const questionPurpose = (task: Task): TaskPurpose =>
  task.autofillContext
    ? "application-answers"
    : task.preset === "questions"
      ? "questions"
      : "documents";

function defineTaskKind(config: TaskKindConfig): TaskKind {
  const metadata = (task: Task) => taskPolicyMetadata(config.purpose(task));
  return {
    ...config,
    prepare: prepareValidatedTask,
    sandbox: (task) => metadata(task).sandbox,
    instructions: (task) => metadata(task).instructions,
    tools: (task) => metadata(task).tools?.(),
  };
}

const genericPrompt = (task: Task) =>
  `${task.prompt}\n\nRead AGENTS.md and context-manifest.json in this isolated draft directory first. Selected context paths:\n${task.manifest!.paths.map((p: string) => `- ${p}`).join("\n")}\nRespect source evidence and the scope above. Keep changes inside this draft bundle. Report changed artifacts and actual validation results. Do not modify the original checkout, Git index, credentials, subscriptions, or send employer messages/applications.`;

const ordinaryKind = defineTaskKind({
  purpose: ordinaryPurpose,
  prepareBundle: (store, task) => prepareBundle(store, task),
  initialize: noInitialization,
  taskFields: noTaskFields,
  prompt: genericPrompt,
  onTurnCompleted: noCompletionHooks,
  questionLike: false,
  requiresPosting: false,
  collectArtifacts: true,
  sourceTools: noSourceTools,
});
const questionsKind = defineTaskKind({
  purpose: questionPurpose,
  prepareBundle: (store, task, reference) =>
    prepareQuestionBundle(store, task, reference),
  initialize: noInitialization,
  taskFields: questionTaskFields,
  prompt: questionPrompt,
  onTurnCompleted: noCompletionHooks,
  questionLike: true,
  requiresPosting: false,
  collectArtifacts: true,
  sourceTools: questionsSourceTools,
});
function postingDocumentKind(sourceTools: SourceToolPolicy) {
  return defineTaskKind({
    purpose: questionPurpose,
    prepareBundle: (store, task, reference) =>
      preparePostingDocumentBundle(store, task, reference),
    initialize: noInitialization,
    taskFields: questionTaskFields,
    prompt: postingDocumentPrompt,
    onTurnCompleted: { afterAutofill: completePostingDocuments },
    questionLike: true,
    requiresPosting: true,
    collectArtifacts: true,
    sourceTools,
  });
}

export const TASK_KINDS = {
  "opening-research": defineTaskKind({
    purpose: fixedPurpose("opening-research"),
    prepareBundle: (store, task) => prepareOpeningResearch(store, task),
    initialize: initializeResearch,
    taskFields: researchTaskFields,
    prompt: researchPrompt,
    onTurnCompleted: { afterAutofill: completeResearch },
    questionLike: false,
    requiresPosting: false,
    collectArtifacts: true,
    sourceTools: researchSourceTools,
  }),
  questions: questionsKind,
  "posting-application": postingDocumentKind(applicationSourceTools),
  "posting-resume": postingDocumentKind(resumeSourceTools),
  "posting-cover-letter": postingDocumentKind(coverLetterSourceTools),
  "resume-revision": ordinaryKind,
  "follow-up-email": defineTaskKind(followUpKindConfig),
  "cover-letter": ordinaryKind,
  "job-fit": ordinaryKind,
  "company-research": ordinaryKind,
  "careers-refresh": ordinaryKind,
} satisfies Record<TaskPreset, TaskKind>;

function isTaskPreset(value: string): value is TaskPreset {
  return Object.prototype.hasOwnProperty.call(TASK_KINDS, value);
}

export function taskKind(preset: string): TaskKind {
  return isTaskPreset(preset) ? TASK_KINDS[preset] : ordinaryKind;
}

export function taskSourceToolPolicy(task: Task) {
  return taskKind(task.preset).sourceTools;
}

export function dispatchTaskSourceTool(
  store: Store,
  task: Task,
  tool: string,
  args: Parameters<NonNullable<SourceToolPolicy["dispatch"]>>[3],
): SourceToolDispatch {
  return (
    taskSourceToolPolicy(task).dispatch?.(store, task, tool, args) ?? {
      handled: false,
    }
  );
}

function validateCreation(
  services: TaskCreationServices,
  body: TaskCreationBody,
): ValidatedCreation {
  const preset = services.string(body.preset, 50);
  if (!isTaskPreset(preset)) throw new HttpError(400, "Unknown task preset");
  const prompt = services.string(body.prompt, 60000).trim();
  if (!prompt)
    throw new HttpError(400, "Write or review the task prompt first");
  const rawContext = body.context ?? {};
  if (
    !rawContext ||
    typeof rawContext !== "object" ||
    Array.isArray(rawContext)
  )
    throw new HttpError(400, "Context must be a record");
  const context = services.pick(rawContext, [
    "documentIds",
    "openingId",
    "companyId",
    "applicationId",
  ]);
  services.documents(context.documentIds ?? []);
  validateContextRecords(services.store, context);
  const clientRequestId =
    body.clientRequestId === undefined
      ? null
      : // Pull reviews embed the candidate id (run, provider, board and posting
        // UUIDs), which already exceeds 100 characters for Ashby and Lever.
        services.string(body.clientRequestId, 300);
  const existing = clientRequestId
    ? services.store.taskForClientRequest(clientRequestId)
    : undefined;
  return {
    body,
    preset,
    kind: TASK_KINDS[preset],
    prompt,
    context,
    clientRequestId,
    existing,
  };
}

function validateContextRecords(store: Store, context: Task["context"]) {
  // Each literal field-kind pair keeps Store's typed lookup correlated.
  for (const [field, kind] of [
    ["openingId", "cache_opening"],
    ["companyId", "cache_company"],
    ["applicationId", "application"],
  ] as const)
    if (
      context[field] &&
      !(field === "openingId"
        ? store.opening(context[field])
        : store.get(kind, context[field])) &&
      !(field === "companyId" && store.get("custom_company", context[field]))
    )
      throw new HttpError(400, "Context record not found");
}

export async function createRegisteredTask(
  services: TaskCreationServices,
  body: TaskCreationBody,
  options: TaskCreationOptions = {},
): Promise<Task | undefined> {
  const request = validateCreation(services, body);
  if (request.existing) return request.existing;
  return request.kind.prepare(services, request, options);
}

function prepareValidatedTask(
  services: TaskCreationServices,
  request: ValidatedCreation,
  options: TaskCreationOptions,
) {
  const pendingSources = resolveCreationSources(services, request, options);
  return pendingSources instanceof Promise
    ? pendingSources.then((sources) =>
        buildAndPrepareTask(services, request, options, sources),
      )
    : buildAndPrepareTask(services, request, options, pendingSources);
}

function resolveCreationSources(
  services: TaskCreationServices,
  request: ValidatedCreation,
  options: TaskCreationOptions,
): CreationSources | Promise<CreationSources> {
  if (!request.kind.questionLike)
    return {
      reference: null,
      opening: request.context.openingId
        ? services.store.opening(request.context.openingId)
        : null,
      posting: null,
      postingLabel: "",
    };
  return resolveQuestionSources(services, request, options);
}

async function resolveQuestionSources(
  services: TaskCreationServices,
  request: ValidatedCreation,
  options: TaskCreationOptions,
): Promise<CreationSources> {
  const reference = await services.questionReference();
  const opening = request.context.openingId
    ? services.store.opening(request.context.openingId)
    : null;
  const savedDescription = opening?.description || opening?.requirements;
  const posting =
    options.autofillContext?.posting ??
    options.preparationContext?.posting ??
    opening?.posting ??
    (savedDescription?.length! > 100
      ? {
          kind: "saved-opening",
          url: opening!.url,
          title: opening!.title,
          text: `Employer: ${opening!.company}\nRole: ${opening!.title}\nLocation: ${opening!.location}\nPublished compensation: ${opening!.compensation}\n\n${savedDescription}`,
          hash: sha256(savedDescription!),
          capturedAt: opening!.sourceDate,
        }
      : await services.suppliedPosting(request.body));
  if (request.kind.requiresPosting && !posting)
    throw new HttpError(
      400,
      "A job posting is required for document generation",
    );
  return {
    reference,
    opening,
    posting,
    postingLabel: services.string(request.body.postingLabel ?? "", 150).trim(),
  };
}

function buildAndPrepareTask(
  services: TaskCreationServices,
  request: ValidatedCreation,
  options: TaskCreationOptions,
  sources: CreationSources,
) {
  const mode = request.body.mode === "live" ? "live" : "handoff";
  const id = randomUUID();
  const task: TaskDraft = {
    id,
    title: request.preset.replaceAll("-", " "),
    preset: request.preset,
    prompt: request.prompt,
    context: request.context,
    status: mode === "live" ? "queued" : "handoff",
    mode,
    clientRequestId: request.clientRequestId,
    threadId: null,
    messages: [],
    eventCount: 0,
    createdAt: now(),
    updatedAt: now(),
    version: 1,
    ...creationOptionFields(options),
    ...request.kind.taskFields(services, request, sources),
  };
  const initialization = request.kind.initialize(services, task, options);
  return initialization instanceof Promise
    ? initialization.then(() =>
        completeTaskCreation(services, request, task, sources, mode),
      )
    : completeTaskCreation(services, request, task, sources, mode);
}

function completeTaskCreation(
  services: TaskCreationServices,
  request: ValidatedCreation,
  task: TaskDraft,
  sources: CreationSources,
  mode: string,
): Task | undefined | Promise<Task | undefined> {
  services.store.put("task", task.id, task);
  let prepared: PreparedBundle;
  try {
    prepared = request.kind.prepareBundle(
      services.store,
      task,
      sources.reference,
    );
  } catch (error) {
    services.store.put("task", task.id, {
      ...task,
      status: "failed",
      error: String(error),
    });
    services.store.autoExport();
    services.publish("state");
    throw error;
  }
  if (request.preset === "posting-application" && sources.opening) {
    const application = startOpeningApplication(
      services.store,
      sources.opening.id,
    );
    task.context = { ...task.context, applicationId: application.id };
  }
  const completed = {
    ...task,
    bundle: prepared.bundle,
    manifest: prepared.manifest,
  };
  services.store.put("task", task.id, completed);
  services.store.autoExport();
  return mode === "live"
    ? services
        .startSavedTask(task.id, request.body)
        .then(() => services.store.get("task", task.id))
    : services.store.get("task", task.id);
}

function researchTaskFields(
  services: TaskCreationServices,
  request: ValidatedCreation,
) {
  return {
    importUrl: postingUrl(services.string(request.body.importUrl, 3000)).href,
    importStatus: "researching",
    title: "Research job posting",
    modelPolicy: "codex-default",
  };
}

function questionTaskFields(
  _services: TaskCreationServices,
  request: ValidatedCreation,
  sources: CreationSources,
) {
  return {
    title:
      request.preset === "questions"
        ? request.prompt.length > 75
          ? request.prompt.slice(0, 72) + "…"
          : request.prompt
        : `${request.preset === "posting-application" ? "Resume + cover letter" : request.preset === "posting-resume" ? "Tailored resume" : "Cover letter"} · ${sources.postingLabel || sources.posting?.title || "job posting"}`,
    posting: sources.posting,
    postingLabel: sources.postingLabel,
    modelPolicy: "codex-default",
  };
}

function initializeResearch(
  services: TaskCreationServices,
  task: TaskDraft,
  options: TaskCreationOptions,
): Promise<void> | void {
  services.store.put("task", task.id, task);
  services.store.autoExport();
  services.publish("state");
  try {
    if (options.greenhouseContext) {
      task.posting = {
        kind: `${options.greenhouseContext.candidate.card.provider ?? "greenhouse"}-api`,
        url: task.importUrl,
        text: options.greenhouseContext.candidate.posting!.text,
        fetchedAt: options.greenhouseContext.candidate.posting!.fetchedAt,
      };
      return;
    }
    return fetchPosting(task.importUrl)
      .then((posting) => {
        task.posting = posting;
      })
      .catch((error) => {
        task.fetchError = String(error);
      });
  } catch (error) {
    task.fetchError = String(error);
  }
}

export function taskPurpose(task: Task): TaskPurpose | undefined {
  return taskKind(task.preset).purpose(task);
}

export function taskPurposeSelection(task: Task) {
  const purpose = taskPurpose(task);
  return purpose ? { purpose } : {};
}

export function taskPrompt(task: Task) {
  return taskKind(task.preset).prompt(task);
}

function resolveEventTask(
  services: TaskEventServices,
  event: AgentEvent,
): Task | undefined | null {
  const threadId =
    event.threadId ?? event.params?.threadId ?? event.params?.thread?.id;
  const launchingTask = services.launchingTask();
  const owner = services.store.taskForThread(threadId);
  // Historical threads remain readable, but cannot change the current turn's state or publish drafts.
  if (owner && owner.threadId !== threadId) return null;
  // Global connection/account events never attach to whichever task happens to be starting.
  return (
    owner ??
    (threadId && event.method === "adapter/threadCreated" && launchingTask
      ? services.store.get("task", launchingTask)
      : null)
  );
}

function collectTurnArtifacts(
  services: TaskEventServices,
  task: Task,
  updated: ReturnType<typeof applyTaskEvent>,
  event: AgentEvent,
) {
  if (
    event.method !== "turn/completed" ||
    !taskKind(task.preset).collectArtifacts
  )
    return;
  try {
    const prior = services.store.get("bundle", task.id);
    if (!prior)
      throw new MissingRecordError(
        409,
        "bundle",
        task.id,
        "Task bundle missing during artifact collection",
      );
    const artifacts = collectArtifacts(services.store, task.id);
    const different =
      JSON.stringify(
        artifacts.map((artifact) => [artifact.path, artifact.hash]),
      ) !==
      JSON.stringify(
        (prior.artifacts ?? []).map((artifact: any) => [
          artifact.path,
          artifact.hash,
        ]),
      );
    updated.bundle = {
      ...prior,
      artifacts,
      ...(different ? { status: "draft", validation: null } : {}),
    };
    services.store.put("bundle", task.id, updated.bundle);
  } catch (error) {
    updated.artifactError = String(error);
  }
}

function runCompletionHooks(
  services: TaskEventServices,
  task: Task,
  event: AgentEvent,
) {
  if (services.stopping?.()) return;
  if (event.method !== "turn/completed") return;
  const hooks = taskKind(task.preset).onTurnCompleted;
  const context = { services, task, event };
  completeAutofill(services, task, event);
  hooks.afterAutofill?.(context);
}

export function handleTaskEvent(
  services: TaskEventServices,
  event: AgentEvent,
) {
  const task = resolveEventTask(services, event);
  if (task) {
    services.store.transaction(() => {
      const at = event.timestamp ?? now();
      const updated = applyTaskEvent(
        task,
        event,
        at,
        services.store.taskSelectionEvents(task.id),
      );
      if (
        services.stopping?.() &&
        (isTaskBusy(task.status) || isTaskBusy(updated.status))
      )
        updated.status = "interrupted";
      if (event.method === "turn/started" && task.autofillContext) {
        updated.autofillDraft = null;
        updated.autofillResult = { status: "drafting" };
      }
      collectTurnArtifacts(services, task, updated, event);
      updated.eventCount = services.store.appendTaskEvent(
        task.id,
        event,
        at,
        task.eventCount ?? 0,
      );
      services.store.put(
        "task",
        task.id,
        withOverflowRecoveryTurn(updated, event),
      );
    });
    runCompletionHooks(services, task, event);
    if (
      [
        "turn/completed",
        "adapter/request",
        "adapter/disconnected",
        "adapter/threadCreated",
      ].includes(event.method)
    )
      services.store.autoExport();
  }
  // Clients use this as an invalidation, not a second copy of tool output.
  services.publish("agent", { method: event.method, taskId: task?.id });
}
