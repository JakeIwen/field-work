import InfoTooltip from "../ui/InfoTooltip";
import { recordedAgentLabel } from "../../shared/codex-models";
import { QuestionModelBadge } from "../questions/ModelSelection";
import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import { api } from "../workspace/api";
import { formatDate } from "../ui/dates";
import { modelLabel, taskSelection } from "../../shared/model-selection";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  ChevronRight,
  FileText,
  Link2,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Square,
} from "lucide-react";
import TaskUsage from "../agents/TaskUsage";
import Markdown from "../ui/Markdown";
import QuestionChatMessage, { taskEndpoint as endpoint } from "../questions/QuestionChatMessage";
import MessageModelPicker from "../questions/MessageModelPicker";
import { documentContextIds, documentPrompt, routeDocumentRequest, submitSearchRequest, type DocumentPreset } from "../agents/document-workflow";
import { useAction } from "../workspace/workspace";
import { isTaskBusy, type AppState } from "../../shared/types";

type Props = {
  state: AppState;
  selected: string;
  go: (page: string, id?: string) => void;
  mutate: (url: string, body: any, method?: string) => Promise<any>;
  renderApproval: (task: any, event: any) => React.ReactNode;
};
const working = (task: any) =>
  task?.documentResult?.status === "rendering" || isTaskBusy(task?.status);
const questionPresets = ["questions", "posting-cover-letter", "posting-resume", "posting-application"];
// Application preparation starts "questions" tasks carrying autofillContext to resolve form questions.
// They are machine runs, so the conversation list hides them unless asked.
const isPreparationRun = (task: any) => task?.preset === "questions" && !!task.autofillContext;
const stamp = (value: string | undefined) => formatDate(value, true);
async function get(url: string) {
  const response = await api(url, undefined, undefined, { responseType: "response" });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? "Could not load question context");
  return body;
}
export default function Questions({
  state,
  selected,
  go,
  mutate,
  renderApproval,
}: Props) {
  const task = state.tasks.find(
    (t) => t.id === selected && questionPresets.includes(t.preset),
  );
  const allConversations = state.tasks
    .filter((t) => questionPresets.includes(t.preset))
    .slice()
    .reverse();
  const conversations = allConversations.filter((t) => !isPreparationRun(t));
  const preparationRuns = allConversations.filter(isPreparationRun);
  const [showPreparationRuns, setShowPreparationRuns] = useState(false);
  const preparationRunsVisible = showPreparationRuns || isPreparationRun(task);
  const files = state.documents
    .filter((d) => d.origin === "generated")
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const [postingLabel, setPostingLabel] = useState("");
  const [context, setContext] = useState<any>(null),
    [loadError, setLoadError] = useState(""),
    [question, setQuestion] = useState(""),
    [postingUrl, setPostingUrl] = useState(""),
    [postingText, setPostingText] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [followup, setFollowup] = useState(""),
    [copied, setCopied] = useState("");
  const [questionModel, setQuestionModel] = useState<string>();
  const [followupModel, setFollowupModel] = useState<string>();
  const {
    run: runPosting,
    busy: loadingUrl,
    error: postingError,
  } = useAction();
  const {
    run,
    busy: submitting,
    error: localError,
    setError: setLocalError,
  } = useAction();
  const [createdTasks, setCreatedTasks] = useState<any[]>([]);
  const requestId = useRef(crypto.randomUUID());
  const followupId = useRef(crypto.randomUUID());
  const revisionIntent = useRef<{ taskId: string; text: string } | null>(null);
  const followupInput = useRef<HTMLTextAreaElement>(null);
  const refresh = () =>
    get("/api/questions/context")
      .then((value) => {
        setContext(value);
        setLoadError("");
      })
      .catch((error) => setLoadError(error.message));
  useEffect(() => {
    void refresh();
  }, [task?.model, task?.effort]);
  useEffect(() => {
    if (revisionIntent.current?.taskId === selected) {
      setFollowup(revisionIntent.current.text);
      revisionIntent.current = null;
      setTimeout(() => followupInput.current?.focus(), 50);
    } else setFollowup("");
    setFollowupModel(undefined);
    setLocalError("");
  }, [selected]);
  const live = context?.available && !!context?.reference;
  const revise = (taskId: string, text: string) => {
    followupId.current = crypto.randomUUID();
    if (task?.id === taskId) {
      setFollowup(text);
      followupInput.current?.focus();
      followupInput.current?.scrollIntoView({ block: "center" });
    } else {
      revisionIntent.current = { taskId, text };
      go("questions", taskId);
    }
  };
  const loadPosting = async () => {
    await runPosting(async () => {
      const value = await mutate("/api/questions/posting", { url: postingUrl });
      setPostingUrl(value.url);
      setPostingText(value.text);
      setPreview(value);
      requestId.current = crypto.randomUUID();
    }, { onError: () => setPreview(null) });
  };
  const ask = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!question.trim() || !live || submitting || loadingUrl) return;
    await run(async () => {
      const values = await submitSearchRequest({
        prompt: question,
        context: { documentIds: documentContextIds(state.documents, question) },
        postingUrl,
        postingText,
        postingLabel,
        postingPreviewId: preview?.id,
        clientRequestId: requestId.current,
        ...(questionModel ? { model: questionModel } : {}),
      }, mutate);
      setCreatedTasks(values);
      setQuestionModel(undefined);
      go("questions", values[0].id);
      requestId.current = crypto.randomUUID();
    });
  };
  const sendFollowup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task || working(task) || submitting || !followup.trim()) return;
    await run(async () => {
      const current = task.preset === "questions" ? undefined : task.preset as DocumentPreset;
      const routes = routeDocumentRequest(followup, current);
      if ((routes.length && (routes.length !== 1 || routes[0] !== current)) ||
          (current && !routes.length)) {
        const values = await submitSearchRequest({
          prompt: followup,
          context: { documentIds: documentContextIds(state.documents, followup, task.documentResult?.documentIds || []) },
          postingTaskId: task.posting ? task.id : undefined,
          postingLabel: task.postingLabel,
          clientRequestId: followupId.current,
          presets: routes,
          ...(followupModel ? { model: followupModel } : {}),
        }, mutate);
        setCreatedTasks(values);
        go("questions", values[0].id);
      } else {
        await mutate(endpoint(task.id, "message"), {
          prompt: current ? documentPrompt(followup, current) : followup,
          clientRequestId: followupId.current,
          ...(followupModel ? { model: followupModel } : {}),
        });
      }
      setFollowup("");
      setFollowupModel(undefined);
      followupId.current = crypto.randomUUID();
    });
  };
  const changedSources =
    task &&
    context?.sources?.some(
      (source: any) =>
        task.manifest?.sourceHashes?.[source.path] &&
        task.manifest.sourceHashes[source.path] !== source.hash,
    );
  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(
        text.replace(/[\u00a0\u2009\u202f]/g, " "),
      );
      setCopied(id);
    } catch {
      setLocalError("Clipboard unavailable. Select and copy the answer text.");
    }
  };
  const pending = task?.pendingRequests ?? [];
  const newRequestTypes = routeDocumentRequest(question);
  return (
    <div className="questions-workspace">
      <div className={`panel qa-connection ${live ? "is-connected" : ""}`}>
        <div>
          <span className={`status-dot ${live ? "" : "offline"}`} />
          <strong>
            {live
              ? "Agent connection available"
              : context
                ? "Questions unavailable"
                : "Checking agent connection…"}
          </strong>
          <QuestionModelBadge preferences={state.settings.codexModels} efforts={state.settings.codexEfforts} fallback={context?.selected} />
        </div>
        <button
          className="text-button"
          onClick={async () => {
            try {
              await mutate("/api/agent/connect", {});
              await refresh();
            } catch {}
          }}
        >
          <RefreshCw size={15} /> Check connection
        </button>
        {(loadError || context?.referenceError || context?.reason) && (
          <p className="small muted">
            {loadError || context.referenceError || context.reason}
          </p>
        )}
      </div>
      {createdTasks.length > 1 && (
        <div className="panel panel-body" role="status">
          <p>Resume and cover letter workflows started. Open each for progress and PDF downloads.</p>
          <div className="row-wrap">
            {createdTasks.map((created, index) => (
              <AppLink className="button secondary small-button" key={created.id}
                go={go} page={"questions"} id={created.id}>
                {index === 0 ? "Resume" : "Cover letter"}
              </AppLink>
            ))}
          </div>
        </div>
      )}
      <details className="panel qa-file-history">
        <summary>
          <FileText size={16} /> Saved application files{" "}
          <span className="badge">{files.length}</span>
        </summary>
        {files.length ? (
          <div className="qa-file-list">
            {files.map((file) => (
              <div className="qa-saved-file" key={file.id}>
                <div>
                  <strong>
                    {file.kind === "resume"
                      ? "Tailored resume"
                      : "Cover letter"}{" "}
                    · {String(file.postingLabel ?? "Job posting")}
                  </strong>
                  <small>
                    {String(file.createdAt).slice(0, 10)} · {file.privacy} ·
                    validation passed
                  </small>
                  <code>{file.name}</code>
                </div>
                <div>
                  <a
                    className="button secondary small-button"
                    href={`/api/documents/${encodeURIComponent(file.id)}/file`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PDF
                  </a>
                  <a
                    className="button primary small-button"
                    href={`/api/documents/${encodeURIComponent(file.id)}/download`}
                    download
                  >
                    Download
                  </a>
                  <AppLink
                    className="text-button"
                    go={go} page={"questions"} id={String(file.generatedBy)}
                  >
                    Conversation
                  </AppLink>
                  {state.tasks
                    .find((t) => t.id === file.generatedBy)
                    ?.documentResult?.documentIds?.includes(file.id) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        revise(
                          String(file.generatedBy),
                          "Revise the current draft and produce a new dated PDF version. Requested changes: ",
                        )
                      }
                    >
                      Revise draft
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-body small muted">
            No saved PDFs yet. Generate a cover letter or tailored resume from a posting.
          </p>
        )}
      </details>
      <div className="qa-layout">
        <aside className="panel qa-history">
          <div className="section-heading compact">
            <h2>Conversations</h2>
            <AppLink
              className="icon-button"
              aria-label="New question conversation"
              title="New question conversation"
              go={go} page="questions" id="new"
              onClick={() => {
                setQuestion("");
                setPostingText("");
                setPostingUrl("");
                setPostingLabel("");
                setPreview(null);
                setQuestionModel(undefined);
                requestId.current = crypto.randomUUID();
              }}
            >
              <Plus size={18} />
            </AppLink>
          </div>
          {conversations.length ? (
            conversations.map((t) => (
              <div className="record-with-delete" key={t.id}><AppLink
                className={`task-row ${t.id === task?.id ? "selected" : ""}`}

                go={go} page={"questions"} id={t.id}
              >
                <MessageSquare size={16} />
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    {t.status} · {stamp(t.createdAt)}
                  </small>
                  <TaskUsage task={t} compact />
                </span>
              </AppLink><DeleteRecord kind="task" id={t.id} label={t.title || t.preset} onDeleted={() => { if (task?.id === t.id) go("questions"); }} /></div>
            ))
          ) : (
            <p className="panel-body small muted">
              Your questions and follow-ups are saved here.
            </p>
          )}
          {preparationRuns.length > 0 && (
            <div className="qa-prep-runs">
              <button
                className="text-button"
                aria-expanded={preparationRunsVisible}
                onClick={() => setShowPreparationRuns(!preparationRunsVisible)}
              >
                {preparationRunsVisible ? "Hide" : "Show"} {preparationRuns.length} preparation run{preparationRuns.length === 1 ? "" : "s"}
              </button>
              {preparationRunsVisible && preparationRuns.map((t) => {
                const openingId = t.openingId ?? t.context?.openingId;
                const opening = openingId ? state.openings.find((o) => o.id === openingId) : undefined;
                return (
                  <div className="qa-prep-row" key={t.id}><DeleteRecord kind="task" id={t.id} label={t.title || "preparation task"} />
                    <AppLink
                      className={`task-row ${t.id === task?.id ? "selected" : ""}`}
                      go={go} page={"questions"} id={t.id}
                    >
                      <MessageSquare size={16} />
                      <span>
                        <strong>{t.title}</strong>
                        <small>
                          {t.status} · {stamp(t.createdAt)}
                        </small>
                      </span>
                    </AppLink>
                    {openingId && (
                      <AppLink
                        className="text-button opening-link"
                        go={go} page={"openings"} id={openingId}
                        aria-label={`Open ${opening ? `${opening.company} ${opening.title}` : "the Opening"}`}
                      >
                        Opening
                      </AppLink>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
        <section className="panel qa-main">
          {!task ? (
            <form onSubmit={ask} className="qa-compose">
              <div className="heading-help">
                <h2>Ask about your job search</h2>
                <InfoTooltip label="About questions and document requests">Ask a question or request a resume or cover letter. Document requests start the PDF workflow; questions stay read-only. Include a posting URL or paste its text.</InfoTooltip>
              </div>
              <div className="qa-examples">
                {[
                  "How should I answer “What is your engineering specialization?”",
                  "Give me a one-line summary of how my experience fits this role.",
                  "Create a PDF cover letter and resume for Northwind.",
                  "What should I ask the recruiter about hours, on-call and work locations?",
                ].map((example) => (
                  <button
                    className="button secondary small-button"
                    type="button"
                    key={example}
                    onClick={() => {
                      setQuestion(example);
                      requestId.current = crypto.randomUUID();
                    }}
                  >
                    {example}
                  </button>
                ))}
              </div>
              <label className="qa-question-label">
                Your question
                <textarea
                  aria-label="Your question"
                  rows={4}
                  maxLength={12000}
                  value={question}
                  placeholder="What would you like help answering?"
                  onChange={(e) => {
                    setQuestion(e.target.value);
                    requestId.current = crypto.randomUUID();
                  }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void ask();
                    }
                  }}
                />
              </label>
              <details className="qa-posting" open={!!localError || undefined}>
                <summary>
                  <Link2 size={15} /> Optional job posting{" "}
                  <InfoTooltip label="About posting sources">URL loading uses no login cookies. If a site blocks access or needs JavaScript, paste the description. When both text and a URL are supplied, the agent receives the text.</InfoTooltip>
                </summary>
                <div className="form-stack">
                  <label>
                    Company / role label (optional)
                    <input
                      aria-label="Posting label"
                      maxLength={150}
                      value={postingLabel}
                      onChange={(e) => {
                        setPostingLabel(e.target.value);
                        requestId.current = crypto.randomUUID();
                      }}
                      placeholder="For example: Northwind Labs Senior Engineer"
                    />
                  </label>
                  <div className="select-field">
                    <span><label htmlFor="question-posting-url">Posting URL</label></span>
                    <div className="qa-url-row">
                      <input
                        id="question-posting-url"
                        type="url"
                        aria-label="Posting URL"
                        value={postingUrl}
                        placeholder="https://…"
                        maxLength={3000}
                        onChange={(e) => {
                          setPostingUrl(e.target.value);
                          setPreview(null);
                          requestId.current = crypto.randomUUID();
                        }}
                      />
                      <button
                        className="button secondary"
                        type="button"
                        disabled={loadingUrl || !postingUrl.trim()}
                        onClick={loadPosting}
                      >
                        {loadingUrl ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Link2 size={15} />
                        )}{" "}
                        Load posting
                      </button>
                    </div>
                  </div>
                  {postingError && (
                    <div className="banner warning">{postingError}</div>
                  )}
                  <label>
                    Posting text
                    <textarea
                      aria-label="Posting text"
                      rows={7}
                      maxLength={60000}
                      value={postingText}
                      placeholder="Paste the job description here. You can use this alone, or edit text loaded from the URL."
                      onChange={(e) => {
                        setPostingText(e.target.value);
                        requestId.current = crypto.randomUUID();
                      }}
                    />
                  </label>
                  {preview && (
                    <p className="tiny muted">
                      {preview.text === postingText
                        ? "Loaded public page"
                        : "Edited posting text"}{" "}
                      · {preview.finalUrl} ·{" "}
                      {stamp(preview.fetchedAt)}
                      {preview.truncated
                        ? " · Limited to 60,000 characters"
                        : ""}
                    </p>
                  )}
                </div>
              </details>
              <details className="qa-sources">
                <summary>
                  <FileText size={15} /> Sources included in each conversation{" "}
                  <InfoTooltip label="About conversation sources">The saved chat supplies earlier decisions and examples; current resume and evidence files take precedence. Hidden reasoning, raw tool output, private documents and raw archives are excluded. Original files and the reference chat are read-only.</InfoTooltip>
                </summary>
                <p className="small">
                  {context?.reference ? (
                    <>
                      “{context.reference.title}” · {context.reference.messages}{" "}
                      saved messages{" "}
                      <a
                        href="/api/questions/reference"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Read reference transcript
                      </a>
                    </>
                  ) : (
                    "Loading the selected reference conversation…"
                  )}
                </p>
                <ul>
                  {context?.sources?.map((source: any) => (
                    <li key={source.path}>
                      <strong>{source.purpose}</strong>
                      <code>{source.path}</code>
                      {!source.available && <span>Unavailable</span>}
                    </li>
                  ))}
                </ul>
                <button
                  className="text-button"
                  type="button"
                  onClick={async () => {
                    try {
                      await mutate("/api/questions/context/refresh", {});
                      await refresh();
                    } catch {}
                  }}
                >
                  Refresh reference chat
                </button>
              </details>
              {localError && (
                <p className="banner danger" role="alert">
                  {localError}
                </p>
              )}
              <div className="qa-send">
                <MessageModelPicker
                  request={newRequestTypes.length ? newRequestTypes : "questions"}
                  preferences={state.settings.codexModels}
                  efforts={state.settings.codexEfforts}
                  fallback={context?.selected}
                  value={questionModel}
                  onChange={setQuestionModel}
                  disabled={submitting}
                  active={submitting}
                />
                <button
                  className="button primary"
                  type="submit"
                  disabled={
                    !live || submitting || loadingUrl || !question.trim()
                  }
                >
                  {submitting ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowUp size={16} />
                  )}{" "}
                  {newRequestTypes.length ? "Create documents" : `Ask ${recordedAgentLabel(questionModel || state.settings.codexModels?.questions || context?.selected?.model)}`}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">{modelLabel(taskSelection(task), "Automatic default · high")}</span>
                  <h2>{task.title}</h2>
                  <span className="badge">{task.status}</span>
                </div>
                {working(task) && (
                  <button
                    className="button secondary small-button"
                    onClick={() =>
                      mutate(endpoint(task.id, "interrupt"), {}).catch(() => {})
                    }
                  >
                    <Square size={14} /> Stop answer
                  </button>
                )}
              </div>
              {task.documentResult && task.documentResult.status !== "ready" && (
                <section className="qa-document-result">
                  <h3>
                    {task.documentResult.status === "rendering"
                      ? "Rendering and validating PDFs…"
                      : "PDF generation needs attention"}
                  </h3>
                  {task.documentResult.error && (
                    <>
                      <p className="banner danger">
                        {task.documentResult.error}
                      </p>
                      <button
                        className="button secondary small-button"
                        onClick={() =>
                          mutate(endpoint(task.id, "render"), {}).catch(
                            () => {},
                          )
                        }
                      >
                        Retry PDF generation
                      </button>
                    </>
                  )}
                  <details>
                    <summary>Validation details</summary>
                    <pre>
                      {JSON.stringify(
                        task.documentResult.validation ?? task.documentResult,
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </section>
              )}
              <details className="qa-sources qa-saved-context">
                <summary>
                  <FileText size={15} /> Saved context{" "}
                  {task.posting ? "and posting" : ""}{" "}
                  <InfoTooltip label="About saved context">This conversation uses a captured snapshot. The original reference session is not resumed.</InfoTooltip>
                </summary>
                <p className="tiny muted">
                  Snapshot captured{" "}
                  {stamp(task.createdAt)}.
                </p>
                {task.posting && (
                  <p>
                    <strong>Posting:</strong>{" "}
                    {task.posting.kind === "url"
                      ? "Public page captured from URL"
                      : "Supplied text"}{" "}
                    {task.posting.url && (
                      <a
                        href={task.posting.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {task.posting.url}
                      </a>
                    )}
                  </p>
                )}
                <ul>
                  {task.manifest?.paths?.map((p: string) => (
                    <li key={p}>
                      <a
                        href={`${endpoint(task.id, "artifact")}?path=${encodeURIComponent(p)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p}
                      </a>
                    </li>
                  ))}
                </ul>
                <a
                  href={endpoint(task.id, "bundle")}
                  className="text-button"
                  download
                >
                  <ArrowDownToLine size={14} /> Export context bundle
                </a>
              </details>
              {changedSources && (
                <p className="banner warning">
                  Some repository sources have changed. This conversation keeps
                  its original context; start a new question to use the latest
                  files.
                </p>
              )}
              <div className="qa-messages" aria-live="polite">
                {(task.messages ?? [])
                  .filter((m: any) => ["user", "assistant"].includes(m.role))
                  .map((message: any, i: number) => (
                    <QuestionChatMessage
                      key={message.id ?? message.itemId ?? i}
                      task={task}
                      message={message}
                      index={i}
                      copied={copied}
                      onCopy={copy}
                    />
                  ))}
                {task.liveText && (
                  <article className="qa-message assistant">
                    <strong>{recordedAgentLabel(task.model)} · {modelLabel(taskSelection(task))}</strong>
                    <Markdown text={task.liveText} task={task} />
                  </article>
                )}
                {working(task) && !task.liveText && (
                  <div className="qa-progress" role="status">
                    <LoaderCircle className="spin" size={17} /> Working on your
                    {task.preset === "questions"
                      ? "question…"
                      : "document revision…"}
                  </div>
                )}
                {task.error && (
                  <div className="banner danger" role="alert">
                    {task.error}
                  </div>
                )}
                {pending.map((event: any) => renderApproval(task, event))}
              </div>
              {(task.status === "disconnected" ||
                task.status === "unavailable" ||
                task.status === "failed") && (
                <div className="qa-recovery">
                  <button
                    className="button secondary"
                    onClick={() =>
                      mutate(
                        endpoint(task.id, task.threadId ? "resume" : "start"),
                        {},
                      ).catch(() => {})
                    }
                  >
                    {task.threadId
                      ? "Reconnect saved conversation"
                      : "Retry this question"}
                  </button>
                </div>
              )}
              <form onSubmit={sendFollowup} className="qa-followup">
                <label>
                  {task.preset === "questions"
                    ? "Follow-up or revision"
                    : "Revision instructions"}
                  <textarea
                    ref={followupInput}
                    aria-label={
                      task.preset === "questions"
                        ? "Follow-up question"
                        : "Revision instructions"
                    }
                    rows={3}
                    value={followup}
                    maxLength={12000}
                    placeholder={
                      task.preset === "questions"
                        ? "Ask for a shorter answer, clarify a claim, or ask another question…"
                        : "Describe what to change. A new dated PDF version will be saved; earlier files stay available."
                    }
                    onChange={(e) => {
                      setFollowup(e.target.value);
                      followupId.current = crypto.randomUUID();
                    }}
                  />
                </label>
                {localError && <p className="banner danger">{localError}</p>}
                <div className="qa-send">
                  <MessageModelPicker
                    request="questions"
                    preferences={state.settings.codexModels}
                    efforts={state.settings.codexEfforts}
                    task={task}
                    fallback={context?.selected}
                    value={followupModel}
                    onChange={setFollowupModel}
                    disabled={working(task) || submitting}
                    active={working(task) || submitting}
                  />
                  <button
                    className="button primary"
                    disabled={
                      !task.threadId ||
                      working(task) ||
                      submitting ||
                      !followup.trim()
                    }
                  >
                    {submitting ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <ArrowUp size={15} />
                    )}{" "}
                    {task.preset === "questions"
                      ? "Send follow-up"
                      : "Revise and generate new PDFs"}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
