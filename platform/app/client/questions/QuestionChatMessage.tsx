import React from "react";
import { recordedAgentLabel } from "../../shared/codex-models";
import { Check, Copy } from "lucide-react";
import { modelLabel, messageSelection } from "../../shared/model-selection";
import type { TaskMessage } from "../../shared/task-records";
import type { TaskSummary } from "../../shared/types";
import Markdown from "../ui/Markdown";
import { formatDate } from "../ui/dates";

export const taskEndpoint = (id: string, action: string) =>
  `/api/tasks/${encodeURIComponent(id)}/${action}`;

type QuestionMessage = TaskMessage & {
  content?: string;
  itemId?: string;
};

type Props = {
  task: TaskSummary;
  message: QuestionMessage;
  index: number;
  copied: string;
  onCopy: (text: string, id: string) => Promise<void>;
};

function Answer({ text, task }: { text: string; task: TaskSummary }) {
  return (
    <div className="chat-text">
      {text.split(/(\[[^\]]+\]\([^)]+\))/g).map((piece, i) => {
        const link = piece.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (!link) return <React.Fragment key={i}>{piece}</React.Fragment>;
        const target = link[2].replace(/^\.\//, "");
        if (/^https?:\/\//i.test(target))
          return (
            <a key={i} href={target} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
        if (task.manifest?.paths?.includes(target))
          return (
            <a
              key={i}
              href={`${taskEndpoint(task.id, "artifact")}?path=${encodeURIComponent(target)}`}
              target="_blank"
              rel="noreferrer"
            >
              {link[1]}
            </a>
          );
        return <React.Fragment key={i}>{piece}</React.Fragment>;
      })}
    </div>
  );
}

export default function QuestionChatMessage({
  task,
  message,
  index,
  copied,
  onCopy,
}: Props) {
  const selection = messageSelection(task, message);
  return (
    <article className={`qa-message ${message.role}`}>
      <div className="qa-message-heading">
        <span className="qa-message-author">
          <strong>
            {message.role === "user"
              ? "You"
              : `${recordedAgentLabel(selection?.model ?? task.model)} · ${modelLabel(selection)}`}
          </strong>
          {message.at && <time className="muted" dateTime={message.at}>{formatDate(message.at, true)}</time>}
        </span>
        {message.role === "assistant" && (
          <div className="qa-answer-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={copied === String(index) ? "Copied" : "Copy answer"}
              title={copied === String(index) ? "Copied" : "Copy answer"}
              onClick={() => onCopy(message.text, String(index))}
            >
              {copied === String(index) ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        )}
      </div>
      {message.role === "assistant" ? (
        <Markdown text={message.text} task={task} />
      ) : (
        <Answer text={message.text} task={task} />
      )}
    </article>
  );
}
