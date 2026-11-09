import { agentProviders, agentProviderLabels, isModelRequestType, taskModelRequestType } from "../../shared/codex-models";
import InfoTooltip from "../ui/InfoTooltip";
import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import { configuredSelection, modelLabel, taskSelection } from "../../shared/model-selection";
import { useEffect, useRef, useState } from "react";
import { documentContextIds, postingUrlFromRequest, routeDocumentRequest, submitSearchRequest } from "../agents/document-workflow";
import TaskUsage from "../agents/TaskUsage";
import { MessageSquare, Plus, RefreshCw } from "lucide-react";
import type { AppState } from "../../shared/types";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { stageLabel } from "../applications/stages";
import { presets } from "../agents/task-presets";
import type { Go, Mutate } from "../workspace/workspace-actions";
import type { Context } from "../agents/task-context";
import { useAction } from "../workspace/workspace";
import { Badge } from "../ui/Badge";
import NewTaskForm from "../agents/NewTaskForm";
import TaskConversation from "../agents/TaskConversation";

export function Agents({
  state,
  selected,
  go,
  mutate,
  context,
}: {
  state: AppState;
  selected: string;
  go: Go;
  mutate: Mutate;
  context: Context;
}) {
  const task = state.tasks.find((t) => t.id === selected);
  const requestedPreset = selected.startsWith("new:")
    ? selected.slice(4)
    : "job-fit";
  const [status, setStatus] = useState<any>(null),
    [statusError, setStatusError] = useState(""),
    [preset, setPreset] = useState(
      presets[requestedPreset] ? requestedPreset : "job-fit",
    ),
    [prompt, setPrompt] = useState(
      presets[requestedPreset]?.prompt || presets["job-fit"].prompt,
    ),
    [ctx, setCtx] = useState<Context>(context),
    [mode, setMode] = useState("handoff"),
    [followup, setFollowup] = useState(""),
    [docQuery, setDocQuery] = useState(""),
    [showEvents, setShowEvents] = useState(false),
    [copied, setCopied] = useState(false);
  const {
    run,
    busy: sending,
    error: documentRequestError,
  } = useAction();
  const refreshStatus = () =>
    api("/api/agent/status")
      .then((s) => {
        setStatus(s);
        setStatusError("");
      })
      .catch((e) => setStatusError(e.message));
  useEffect(() => {
    refreshStatus();
  }, [task?.updatedAt]);
  useEffect(() => {
    if (selected.startsWith("new:")) {
      const key = presets[requestedPreset] ? requestedPreset : "job-fit";
      setPreset(key);
      setPrompt(presets[key].prompt);
      setCtx(context);
    }
  }, [selected, context]);
  const liveAvailable = status?.available === true;
  const availableProviders = agentProviders.filter((provider) => status?.providers?.[provider]?.available);
  const providerLabel = availableProviders.map((provider) => agentProviderLabels[provider]).join(" and ");
  const documentRequestId = useRef(crypto.randomUUID());
  useEffect(() => { documentRequestId.current = crypto.randomUUID(); }, [prompt, ctx]);
  const start = async () => {
    await run(async () => {
      if (mode === "live" && routeDocumentRequest(prompt).length) {
        const selectedOpening = state.openings.find((o) => o.id === ctx.openingId);
        const results = await submitSearchRequest({
          prompt,
          context: { ...ctx, documentIds: documentContextIds(state.documents, prompt, ctx.documentIds) },
          postingUrl: postingUrlFromRequest(prompt) || selectedOpening?.url,
          postingLabel: selectedOpening?.company,
          clientRequestId: documentRequestId.current,
        }, mutate);
        documentRequestId.current = crypto.randomUUID();
        go("questions", results[0].id);
        return;
      }
      const result = await mutate("/api/tasks", {
        preset,
        prompt,
        context: ctx,
        mode,
        clientRequestId: crypto.randomUUID(),
      });
      go("agents", result.id || result.task?.id);
    });
  };
  const opening = state.openings.find(
    (o) => o.id === (task?.context?.openingId || ctx.openingId),
  );
  const company = state.companies.find(
    (c) => c.id === (task?.context?.companyId || ctx.companyId),
  );
  const requestEvents = (status?.pendingRequests || []).filter(
    (r: any) => r.threadId === task?.threadId,
  );
  return (
    <>
      {documentRequestError && <p className="banner danger" role="alert">{documentRequestError} Use Questions to supply posting text.</p>}
      <div
        className={`agent-status panel ${liveAvailable ? "is-connected" : ""}`}
      >
        <span className={`status-dot ${liveAvailable ? "" : "offline"}`} />
        <div>
          <div className="heading-help">
            <strong>
              {liveAvailable
                ? providerLabel ? `${providerLabel} ${availableProviders.length > 1 ? "are" : "is"} available` : "Agent connection is available"
                : "Direct agent connection unavailable"}
            </strong>
            {liveAvailable && <InfoTooltip label="About agent connections">Conversations run on the Fieldwork backend using existing sign-ins. New tasks use the saved model’s provider; existing threads stay with their original provider.</InfoTooltip>}
          </div>
          {(!liveAvailable || statusError) && <p role={statusError ? "alert" : "status"}>
            {statusError || status?.error || status?.reason || "Checking backend agent connections. Handoff prompts remain available."}
          </p>}
          {status?.selected && (
            <span className="tiny muted">
              {task?.threadId ? "Conversation model" : state.settings.codexModels?.[isModelRequestType(preset) ? preset : "job-fit"] ? "Saved model" : "Automatic default"}: {modelLabel(task?.threadId ? taskSelection(task) : configuredSelection(state.settings.codexModels, task ? taskModelRequestType(task) : isModelRequestType(preset) ? preset : "job-fit", status.selected, state.settings.codexEfforts))}
            </span>
          )}
        </div>
        <button
          className="button secondary small-button"
          onClick={() =>
            mutate("/api/agent/connect", {})
              .then(refreshStatus)
              .catch(refreshStatus)
          }
        >
          <RefreshCw size={14} />{" "}
          {liveAvailable ? "Refresh connection" : "Connect / retry"}
        </button>
      </div>
      <div className="agent-layout">
        <aside className="panel task-list">
          <div className="section-heading">
            <div className="heading-help">
              <h2>Conversations & tasks</h2>
              <InfoTooltip label="About conversation context">Only project context is supplied. Your existing desktop conversation is not automatically attached.</InfoTooltip>
            </div>
            <AppLink
              className="icon-button"
              aria-label="New agent task"
              title="New agent task"
              go={go} page={"agents"} id={"new:job-fit"}
            >
              <Plus size={19} />
            </AppLink>
          </div>
          {state.tasks.length ? (
            state.tasks
              .slice()
              .reverse()
              .map((t) => (
                <div className="record-with-delete" key={t.id}><AppLink

                  className={`task-row ${task?.id === t.id ? "selected" : ""}`}
                  go={go} page={[
                        "questions",
                        "posting-cover-letter",
                        "posting-resume",
                      ].includes(t.preset)
                        ? "questions"
                        : "agents"} id={t.id}
                >
                  <MessageSquare size={16} />
                  <span>
                    <strong>
                      {t.title || presets[t.preset]?.title || t.preset}
                    </strong>
                    <span className="badge-row">
                      <Badge
                        tone={
                          t.status === "completed"
                            ? "green"
                            : /failed|waiting/.test(t.status)
                              ? "amber"
                              : "muted"
                        }
                      >
                        {stageLabel(t.status)}
                      </Badge>
                      <small>{t.mode === "handoff" ? "Handoff" : "Live"}</small>
                      <TaskUsage task={t} compact />
                    </span>
                    <small>
                      {formatDate(t.updatedAt, true)}
                    </small>
                  </span>
                </AppLink><DeleteRecord kind="task" id={t.id} label={t.title || t.preset} onDeleted={() => { if (task?.id === t.id) go("agents"); }} /></div>
              ))
          ) : (
            <div className="quiet-empty">
              <span>
                Saved conversations and task artifacts will appear here.
              </span>
            </div>
          )}
        </aside>
        <section className="panel agent-main">
          {!task ? (
            <NewTaskForm
              preset={preset}
              setPreset={setPreset}
              prompt={prompt}
              setPrompt={setPrompt}
              ctx={ctx}
              setCtx={setCtx}
              docQuery={docQuery}
              setDocQuery={setDocQuery}
              openings={state.openings}
              companies={state.companies}
              documents={state.documents}
              opening={opening}
              company={company}
              mode={mode}
              setMode={setMode}
              liveAvailable={liveAvailable}
              sending={sending}
              start={start}
            />
          ) : (
            <TaskConversation
              task={task}
              opening={opening}
              state={state}
              go={go}
              mutate={mutate}
              liveAvailable={liveAvailable}
              refreshStatus={refreshStatus}
              copied={copied}
              setCopied={setCopied}
              requestEvents={requestEvents}
              showEvents={showEvents}
              setShowEvents={setShowEvents}
              followup={followup}
              setFollowup={setFollowup}
              run={run}
              sending={sending}
              returnedArtifacts={
                <ReturnedArtifacts task={task} state={state} mutate={mutate} />
              }
            />
          )}
        </section>
      </div>
    </>
  );
}
export function ReturnedArtifacts({
  task,
  state,
  mutate,
}: {
  task: any;
  state: AppState;
  mutate: Mutate;
}) {
  const [artifact, setArtifact] = useState("");
  return (
    <div className="returned-artifacts">
      <div className="heading-help">
        <h3>Associate a returned artifact</h3>
        <InfoTooltip label="About returned artifacts">After external agent work, rescan files and link the resulting document to this task.</InfoTooltip>
      </div>
      <div className="inline-form">
        <select
          aria-label="Returned artifact"
          value={artifact}
          onChange={(e) => setArtifact(e.target.value)}
        >
          <option value="">Select a cataloged document</option>
          {state.documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.company || "General"} · {d.version} · {d.name}
            </option>
          ))}
        </select>
        <button
          className="button secondary small-button"
          disabled={!artifact}
          onClick={() =>
            mutate(`${entityUrl("/api/tasks", task.id)}/artifacts`, {
              documentIds: [artifact],
            })
              .then(() => setArtifact(""))
              .catch(() => {})
          }
        >
          Associate artifact
        </button>
      </div>
    </div>
  );
}
