import { recordedAgentLabel } from "../../shared/codex-models";
import { Sparkles } from "lucide-react";
import { modelLabel, messageSelection } from "../../shared/model-selection";
import type { TaskMessage, TaskSummary } from "../../shared/task-records";
import Markdown from "../ui/Markdown";
import { formatDate } from "../ui/dates";
import { stageLabel } from "../applications/stages";

type AgentChatMessageProps = {
  task: TaskSummary;
  message: TaskMessage & { content?: string };
};

export default function AgentChatMessage({
  task,
  message,
}: AgentChatMessageProps) {
  const selection = messageSelection(task, message);
  return (
    <article
      className={`chat-message ${message.role === "user" ? "user" : "assistant"}`}
    >
      <div className="chat-author">
        {message.role === "user" ? (
          <span className="mini-avatar">U</span>
        ) : (
          <Sparkles size={15} />
        )}
        <strong>
          {message.role === "user"
            ? "You"
            : message.role === "assistant"
              ? `${recordedAgentLabel(selection?.model ?? task.model)} · ${modelLabel(selection)}`
              : stageLabel(message.role)}
        </strong>
        <span>{formatDate(message.at, true)}</span>
      </div>
      {message.role === "assistant" ? (
        <Markdown text={message.text || message.content || ""} task={task} />
      ) : (
        <div className="chat-text">
          {message.text || message.content || ""}
        </div>
      )}
      {message.delivery && message.delivery !== "sent" && (
        <span className="tiny muted">Delivery: {message.delivery}</span>
      )}
    </article>
  );
}
