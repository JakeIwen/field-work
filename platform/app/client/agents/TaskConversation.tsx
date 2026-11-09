import InfoTooltip from "../ui/InfoTooltip";
import { recordedAgentLabel } from "../../shared/codex-models";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  LoaderCircle,
  RefreshCw,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import { modelLabel, taskSelection } from "../../shared/model-selection";
import type {
  TaskMessage,
  TaskRequest,
  TaskSummary,
} from "../../shared/task-records";
import { isTaskBusy, type AppState } from "../../shared/types";
import AppLink from "../ui/AppLink";
import Markdown from "../ui/Markdown";
import TaskEvents from "./TaskEvents";
import TaskUsage from "./TaskUsage";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { presets } from "./task-presets";
import { stageLabel } from "../applications/stages";
import type { Go, Mutate } from "../workspace/workspace-actions";
import type { useAction } from "../workspace/workspace";
import { Badge } from "../ui/Badge";
import AgentChatMessage from "./AgentChatMessage";
import ApprovalRequest from "./ApprovalRequest";
import RevisionBundle from "./RevisionBundle";

type SetValue<T> = Dispatch<SetStateAction<T>>;
type ActionRun = ReturnType<typeof useAction>["run"];

type TaskConversationProps = {
  task: TaskSummary;
  opening?: AppState["openings"][number];
  state: AppState;
  go: Go;
  mutate: Mutate;
  liveAvailable: boolean;
  refreshStatus: () => Promise<unknown>;
  copied: boolean;
  setCopied: SetValue<boolean>;
  requestEvents: TaskRequest[];
  showEvents: boolean;
  setShowEvents: SetValue<boolean>;
  followup: string;
  setFollowup: SetValue<string>;
  run: ActionRun;
  sending: boolean;
  returnedArtifacts: ReactNode;
};

const eventTotal = (task: { eventCount?: number; events?: { length: number } }) =>
  task.eventCount ?? task.events?.length ?? 0;

function ConversationHeader({
  task,
  opening,
  go,
  mutate,
}: Pick<TaskConversationProps, "task" | "opening" | "go" | "mutate">) {
  return (
    <div className="section-heading">
      <div>
        <span className="eyebrow">
          {task.mode === "handoff" ? "Saved handoff" : `${recordedAgentLabel(task.model)} conversation`}
        </span>
        <h2>{task.title || presets[task.preset]?.title || task.preset}</h2>
        <div className="badge-row">
          <Badge
            tone={
              task.status === "completed"
                ? "green"
                : /failed|waiting/.test(task.status)
                  ? "amber"
                  : "muted"
            }
          >
            {stageLabel(task.status)}
          </Badge>
          {opening && (
            <AppLink
              className="text-button small"
              go={go} page={"openings"} id={opening.id}
            >
              {opening.company} <ArrowRight size={12} />
            </AppLink>
          )}
        </div>
      </div>
      {task.mode === "live" && isTaskBusy(task.status) && (
        <button
          className="button secondary small-button"
          onClick={() =>
            mutate(`${entityUrl("/api/tasks", task.id)}/interrupt`, {}).catch(
              () => {},
            )
          }
        >
          <Square size={13} /> Interrupt
        </button>
      )}
    </div>
  );
}

function TaskControls({
  task,
  liveAvailable,
  refreshStatus,
  mutate,
}: Pick<
  TaskConversationProps,
  "task" | "liveAvailable" | "refreshStatus" | "mutate"
>) {
  return (
    <div className="row-wrap task-controls">
      {task.threadId && (
        <button
          className="button secondary small-button"
          onClick={() =>
            mutate(`${entityUrl("/api/tasks", task.id)}/resume`, {})
              .then(refreshStatus)
              .catch(() => {})
          }
        >
          <RefreshCw size={13} /> Reopen saved {recordedAgentLabel(task.model)} thread
        </button>
      )}
      {!task.threadId &&
        liveAvailable &&
        ["handoff", "unavailable", "failed"].includes(task.status) && (
          <button
            className="button primary small-button"
            onClick={() =>
              mutate(`${entityUrl("/api/tasks", task.id)}/start`, {})
                .then(refreshStatus)
                .catch(() => {})
            }
          >
            <Send size={13} /> Start saved task in {recordedAgentLabel(task.model)}
          </button>
        )}
    </div>
  );
}

function TaskError({ task }: Pick<TaskConversationProps, "task">) {
  return task.error && (
    <div className="banner danger">
      <AlertTriangle size={18} />
      <span>
        {typeof task.error === "string"
          ? task.error
          : JSON.stringify(task.error)}
      </span>
    </div>
  );
}

function HandoffBox({
  task,
  copied,
  setCopied,
}: Pick<TaskConversationProps, "task" | "copied" | "setCopied">) {
  return task.mode === "handoff" ? (
    <div className="handoff-box">
      <h3>
        <ArrowDownToLine size={18} /> Ready to continue in Codex
      </h3>
      <p>
        This is a saved task prompt and context manifest. No agent has run this
        task.
      </p>
      <div className="row-wrap">
        <a
          className="button secondary"
          href={`${entityUrl("/api/tasks", task.id)}/export`}
          download
        >
          Export prompt & context
        </a>
        <button
          className="text-button"
          onClick={async () => {
            try {
              const text = await (
                await api(
                  `${entityUrl("/api/tasks", task.id)}/export`,
                  undefined,
                  undefined,
                  { responseType: "response" },
                )
              ).text();
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy handoff"}
        </button>
      </div>
      <p className="small muted">From this checkout, start the installed CLI:</p>
      <code className="command">
        cd /path/to/fieldwork
        <br />
        codex
      </code>
      <p className="tiny muted">
        Paste the exported prompt in Codex. Scope and context remain editable.
      </p>
    </div>
  ) : null;
}

function SavedMessages({
  task,
}: {
  task: TaskSummary;
}) {
  const messages: TaskMessage[] = task.messages?.length
    ? task.messages
    : [{ role: "user", text: task.prompt, at: task.createdAt }];
  return (
    <>
      {messages.map((message, i) => (
        <AgentChatMessage
          key={message.id || i}
          task={task}
          message={message}
        />
      ))}
    </>
  );
}

function StreamingMessage({ task }: Pick<TaskConversationProps, "task">) {
  return task.liveText && (
    <article className="chat-message assistant">
      <div className="chat-author">
        <Sparkles size={15} />
        <strong>{recordedAgentLabel(task.model)} · {modelLabel(taskSelection(task))}</strong>
        <span>Streaming</span>
      </div>
      <Markdown text={task.liveText} task={task} />
    </article>
  );
}

function TaskContext({ task }: Pick<TaskConversationProps, "task">) {
  return (
    <details className="task-context">
      <summary>Task context & persistent identifiers <InfoTooltip label="About task persistence">Refreshing the browser does not restart this task. Reload app stops active work unless you choose Reload when idle.</InfoTooltip></summary>
      <div className="context-manifest">
        <code>Task: {task.id}</code>
        {task.threadId && <code>{recordedAgentLabel(task.model)} thread: {task.threadId}</code>}
        <pre>{JSON.stringify(task.context, null, 2)}</pre>
      </div>
    </details>
  );
}

function EventsControl({
  task,
  showEvents,
  setShowEvents,
}: Pick<TaskConversationProps, "task" | "showEvents" | "setShowEvents">) {
  return (
    <>
      <button
        className="text-button events-toggle"
        onClick={() => setShowEvents(!showEvents)}
      >
        <Activity size={14} />
        {showEvents ? "Hide" : "Show"} progress events ({eventTotal(task)})
      </button>
      {showEvents && (
        <TaskEvents
          key={task.id}
          taskId={task.id}
          version={task.version}
        />
      )}
    </>
  );
}

function ConversationPanel(props: TaskConversationProps) {
  const taskStatus = props.task.status || "";
  return (
    <div className="conversation">
      <TaskControls
        task={props.task}
        liveAvailable={props.liveAvailable}
        refreshStatus={props.refreshStatus}
        mutate={props.mutate}
      />
      <TaskError task={props.task} />
      <HandoffBox
        task={props.task}
        copied={props.copied}
        setCopied={props.setCopied}
      />
      <SavedMessages
        task={props.task}
      />
      <StreamingMessage task={props.task} />
      {props.task.mode === "live" && taskStatus === "running" && (
        <div className="running-indicator">
          <LoaderCircle size={15} className="spin" /> {recordedAgentLabel(props.task.model)} is working. Events
          appear as they arrive.
        </div>
      )}
      {props.requestEvents.map((request) => (
        <ApprovalRequest
          key={request.requestId}
          task={props.task}
          event={request}
          mutate={props.mutate}
        />
      ))}
      {props.task.bundle && (
        <RevisionBundle
          bundle={props.task.bundle}
          task={props.task}
          state={props.state}
          go={props.go}
          mutate={props.mutate}
        />
      )}
      <TaskContext task={props.task} />
      <EventsControl
        task={props.task}
        showEvents={props.showEvents}
        setShowEvents={props.setShowEvents}
      />
    </div>
  );
}

function FollowupForm({
  task,
  followup,
  setFollowup,
  run,
  sending,
  mutate,
}: Pick<
  TaskConversationProps,
  "task" | "followup" | "setFollowup" | "run" | "sending" | "mutate"
>) {
  return (
    <form
      className="followup-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await mutate(`${entityUrl("/api/tasks", task.id)}/message`, {
            prompt: followup,
            clientRequestId: crypto.randomUUID(),
          });
          setFollowup("");
        }, { clearError: false, recordError: false });
      }}
    >
      <label htmlFor="agent-followup" className="sr-only">
        Follow-up instruction
      </label>
      <textarea
        id="agent-followup"
        rows={3}
        value={followup}
        onChange={(e) => setFollowup(e.target.value)}
        placeholder="Give a follow-up instruction…"
      />
      <div>
        <button
          className="button primary small-button"
          disabled={sending || !followup.trim()}
        >
          <Send size={14} /> Send follow-up
        </button>
      </div>
    </form>
  );
}

export default function TaskConversation(props: TaskConversationProps) {
  return (
    <>
      <ConversationHeader
        task={props.task}
        opening={props.opening}
        go={props.go}
        mutate={props.mutate}
      />
      <span className="badge">
        Conversation: {modelLabel(taskSelection(props.task))}
      </span>
      <TaskUsage task={props.task} />
      <ConversationPanel {...props} />
      {props.task.mode === "live" ? (
        <FollowupForm
          task={props.task}
          followup={props.followup}
          setFollowup={props.setFollowup}
          run={props.run}
          sending={props.sending}
          mutate={props.mutate}
        />
      ) : (
        props.returnedArtifacts
      )}
    </>
  );
}
