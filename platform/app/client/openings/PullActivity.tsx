import React, { useState } from "react";
import { greenhouseActivityLane, greenhouseActivityLevel, type GreenhouseActivity } from "../../shared/greenhouse-pull";
import AppLink from "../ui/AppLink";
import { api } from "../workspace/api";
import { type Go } from "../workspace/workspace-actions";

const activityClasses = {
  [greenhouseActivityLevel.info]: "",
  [greenhouseActivityLevel.warn]: "warning-text",
  [greenhouseActivityLevel.error]: "error-text",
};
const activityPanes = [
  { lane: greenhouseActivityLane.search, title: "Greenhouse" },
  { lane: greenhouseActivityLane.review, title: "Reviews" },
];

export function PullActivity({ activity = [], go, runId }: { activity?: GreenhouseActivity[]; go: Go; runId?: string }) {
  return <div className="pull-activity">
    {activityPanes.map(pane => {
      const entries = activity.filter(entry => entry.lane === pane.lane).reverse();
      return <section className="pull-activity-pane" key={pane.lane} aria-label={pane.title}>
        <h3>{pane.title}</h3>
        <div className="pull-activity-scroll" tabIndex={0} role="region" aria-label={`${pane.title} activity`}>
          {entries.length ? <ol>
            {entries.map((entry, index) => <li className={`pull-activity-line ${activityClasses[entry.level]}`.trim()} key={`${entry.at}:${index}`}>
              <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{new Date(entry.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}</time>
              {entry.lane === greenhouseActivityLane.review && entry.taskId
                ? <AppLink page="agents" id={entry.taskId} go={go}>{entry.text}</AppLink>
                : <span>{entry.text}</span>}
              {entry.remembered && entry.candidateId && runId && <ReviewAgain key={`${runId}:${entry.candidateId}:${entry.at}`} runId={runId} candidateId={entry.candidateId} />}
            </li>)}
          </ol> : <p className="muted">No activity yet</p>}
        </div>
      </section>;
    })}
  </div>;
}

function ReviewAgain({ runId, candidateId }: { runId: string; candidateId: string }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function rereview() {
    setPending(true); setError("");
    try {
      await api(`/api/greenhouse/pulls/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}/rereview`, {});
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  return <span><button type="button" className="text-button" disabled={pending || done} title="Clear this remembered decision. Review now if this pull is running or finishing; otherwise review it in the next pull." onClick={() => void rereview()}>{done ? "Memory cleared" : pending ? "Clearing…" : "Review again"}</button>{error && <span className="error-text" role="alert">{error}</span>}</span>;
}
