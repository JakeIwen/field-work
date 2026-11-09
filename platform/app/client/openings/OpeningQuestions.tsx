import { useState } from "react";
import type { AppState, Opening } from "../../shared/types";
import type { Go, Mutate } from "../workspace/workspace-actions";
import AppLink from "../ui/AppLink";
import DeleteRecord from "../ui/DeleteRecord";
import ErrorNotice from "../ui/ErrorNotice";
import Markdown from "../ui/Markdown";
import { taskBusy, taskFailed } from "./OpeningWorkflow";
import { useTextCopy } from "../ui/useTextCopy";

export default function OpeningQuestions({ opening, state, mutate, go }: { opening: Opening; state: AppState; mutate: Mutate; go: Go }) {
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const { copied, copy } = useTextCopy(setError);
  const answers = state.tasks.filter(t => t.context?.openingId === opening.id && t.preset === "questions" && !t.autofillContext).slice().reverse();
  return <details className="opening-questions">
    <summary>Application questions</summary>
    <div className="opening-questions-body">
      <form className="form-stack" onSubmit={async e => {
        e.preventDefault(); setAsking(true); setError("");
        try { await mutate(`/api/openings/${encodeURIComponent(opening.id)}/questions`, { question, clientRequestId: crypto.randomUUID() }); setQuestion(""); }
        catch (e) { setError(String(e)); } finally { setAsking(false); }
      }}>
        <label htmlFor={`opening-question-${opening.id}`}>Paste a question from the application</label>
        <textarea id={`opening-question-${opening.id}`} rows={3} required value={question} onChange={e => setQuestion(e.target.value)} placeholder="What interests you about this opening?" />
        <button className="button secondary" disabled={asking || !question.trim()}>{asking ? "Asking…" : "Get an answer"}</button>
      </form>
      {answers.map(t => {
        const answer = t.status === "completed" ? t.messages?.filter(m => m.role === "assistant").at(-1)?.text : null;
        return <details key={t.id} open={answers[0]?.id === t.id} className="opening-answer"><summary>{t.prompt}</summary><DeleteRecord kind="task" id={t.id} label={t.title || "application answer"} />
          {taskBusy(t) && <p role="status">Writing an answer…</p>}
          {taskFailed(t) && <ErrorNotice error={t.error || "This answer needs a retry."} />}
          {answer && <><Markdown text={answer} /><button className="text-button" onClick={() => copy(answer, t.id)}>{copied === t.id ? "Copied" : "Copy answer"}</button></>}
          <AppLink className="text-button" go={go} page="questions" id={t.id}>Revise or view conversation</AppLink>
        </details>;
      })}
      {error && <ErrorNotice error={error} />}
    </div>
  </details>;
}
