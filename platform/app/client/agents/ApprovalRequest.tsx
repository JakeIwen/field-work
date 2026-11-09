import { useId, useState } from "react";
import { recordedAgentLabel } from "../../shared/codex-models";
import { CircleHelp } from "lucide-react";
import { entityUrl } from "../shell/entity-url";
import type { Mutate } from "../workspace/workspace-actions";

type ApprovalRequestProps = {
  task: any;
  event: any;
  mutate: Mutate;
};

type RequestParams = ApprovalRequestProps["event"]["params"];
type Respond = (
  response: Parameters<Mutate>[1],
) => ReturnType<Mutate>;
type Answers = Record<string, string>;
type SetAnswers = (value: Answers | ((current: Answers) => Answers)) => void;
type SetString = (value: string) => void;

function ApprovalHeader({
  method,
  params,
  provider,
}: {
  method: ApprovalRequestProps["event"]["method"];
  params: RequestParams;
  provider: string;
}) {
  return (
    <>
      <h3>
        <CircleHelp size={18} />
        {method === "item/tool/requestUserInput"
          ? `${provider} needs input`
          : `${provider} requests approval`}
      </h3>
      <p>
        {params.reason ||
          params.message ||
          "Review the actual request before responding."}
      </p>
      <details>
        <summary>Actual request details</summary>
        <pre>{JSON.stringify(params, null, 2)}</pre>
      </details>
    </>
  );
}

function UserInputQuestion({ question, answers, setAnswers }: {
  question: RequestParams["questions"][number];
  answers: Answers;
  setAnswers: SetAnswers;
}) {
  const id = useId();
  const hasOptions = question.options?.length > 0;
  return (
    <div className="form-stack">
      {question.header && <strong>{question.header}</strong>}
      <label htmlFor={hasOptions ? `${id}-choice` : `${id}-answer`}>
        {question.question}
      </label>
      {hasOptions && (
        <>
          <select
            id={`${id}-choice`}
            value={answers[question.id] || ""}
            onChange={(e) => setAnswers((current) => ({ ...current, [question.id]: e.target.value }))}
          >
            <option value="">Choose an answer or write below</option>
            {question.options.map((option: any) => (
              <option value={option.label} key={option.label}>
                {option.label} · {option.description}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-answer`}>Written answer for {question.question}</label>
        </>
      )}
      <textarea
        id={`${id}-answer`}
        rows={2}
        value={answers[question.id] || ""}
        onChange={(e) => setAnswers((current) => ({ ...current, [question.id]: e.target.value }))}
        required
      />
    </div>
  );
}

function UserInputForm({
  params,
  answers,
  setAnswers,
  respond,
}: {
  params: RequestParams;
  answers: Answers;
  setAnswers: SetAnswers;
  respond: Respond;
}) {
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        respond({
          answers: Object.fromEntries(
            (params.questions || []).map((q: any) => [
              q.id,
              { answers: [answers[q.id] || ""] },
            ]),
          ),
        });
      }}
    >
      {(params.questions || []).map((question: any) => (
        <UserInputQuestion key={question.id} question={question} answers={answers} setAnswers={setAnswers} />
      ))}
      <button className="button primary small-button">Send response</button>
    </form>
  );
}

function PermissionsRequest({ respond }: { respond: Respond }) {
  return (
    <>
      <p className="small">
        Additional filesystem permissions cannot extend this task’s isolated
        revision boundary. Continue externally if broader access is needed.
      </p>
      <button
        className="button secondary"
        onClick={() => respond({ permissions: {}, scope: "turn" })}
      >
        Decline extra permissions
      </button>
    </>
  );
}

function ElicitationRequest({
  structured,
  setStructured,
  error,
  setError,
  respond,
}: {
  structured: string;
  setStructured: SetString;
  error: string;
  setError: SetString;
  respond: Respond;
}) {
  return (
    <>
      <label>
        Requested structured response
        <textarea
          rows={4}
          value={structured}
          onChange={(e) => setStructured(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="row-wrap">
        <button
          className="button secondary"
          onClick={() => respond({ action: "decline" })}
        >
          Decline
        </button>
        <button
          className="button primary"
          onClick={() => {
            try {
              const content = JSON.parse(structured);
              respond({ action: "accept", content });
            } catch {
              setError("Enter valid JSON matching the requested fields.");
            }
          }}
        >
          Send this response
        </button>
      </div>
    </>
  );
}

function DecisionButtons({ respond }: { respond: Respond }) {
  return (
    <div className="row-wrap">
      <button
        className="button secondary"
        onClick={() => respond({ decision: "decline" })}
      >
        Decline
      </button>
      <button
        className="button secondary"
        onClick={() => respond({ decision: "cancel" })}
      >
        Cancel task request
      </button>
      <button
        className="button primary"
        onClick={() => respond({ decision: "accept" })}
      >
        Approve this request once
      </button>
    </div>
  );
}

export default function ApprovalRequest({
  task,
  event,
  mutate,
}: ApprovalRequestProps) {
  const params = event.params || {};
  const requestId = event.requestId;
  const method = event.method;
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [structured, setStructured] = useState("{}"),
    [error, setError] = useState("");
  const respond = (response: any) =>
    mutate(`${entityUrl("/api/tasks", task.id)}/respond`, {
      requestId,
      response,
    }).catch(() => {});
  return (
    <div className="approval-request">
      <ApprovalHeader method={method} params={params} provider={recordedAgentLabel(task.model)} />
      {method === "item/tool/requestUserInput" ? (
        <UserInputForm
          params={params}
          answers={answers}
          setAnswers={setAnswers}
          respond={respond}
        />
      ) : method === "item/permissions/requestApproval" ? (
        <PermissionsRequest respond={respond} />
      ) : method === "mcpServer/elicitation/request" ? (
        <ElicitationRequest
          structured={structured}
          setStructured={setStructured}
          error={error}
          setError={setError}
          respond={respond}
        />
      ) : (
        <DecisionButtons respond={respond} />
      )}
    </div>
  );
}
