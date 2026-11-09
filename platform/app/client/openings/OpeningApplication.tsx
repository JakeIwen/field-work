import { useId, useState } from "react";
import type { AppState, Application, Opening } from "../../shared/types";
import { formatDate } from "../ui/dates";
import { stageLabel } from "../applications/stages";
import { type Mutate } from "../workspace/workspace-actions";
import { Badge } from "../ui/Badge";
import { ApplicationTracking } from "../applications/OpeningStageForm";

/** Stage, next action and follow-up for the Opening's application, edited without leaving the Opening. */
export default function OpeningApplication({
  opening,
  application,
  state,
  mutate,
}: {
  opening: Opening;
  application?: Application;
  state: AppState;
  mutate: Mutate;
}) {
  const [starting, setStarting] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const headingId = useId();
  return (
    <details className="opening-application" aria-labelledby={headingId}>
      <summary id={headingId}>
        Application{" "}
        {application ? (
          <Badge tone={application.submittedAt ? "blue" : "muted"}>{stageLabel(application.status)}</Badge>
        ) : (
          <span className="small muted">Not started</span>
        )}
      </summary>
      <div className="opening-application-body">
      {!application ? (
        <>
          <button
            className="button secondary small-button"
            disabled={starting}
            title="Track this application’s stage and follow-up in Fieldwork without contacting the employer."
            onClick={() => {
              setStarting(true);
              mutate("/api/applications", { openingId: opening.id })
                .catch(() => {})
                .finally(() => setStarting(false));
            }}
          >
            {starting ? "Starting…" : "Start application"}
          </button>
        </>
      ) : (
        <>
          {application.submittedAt && (
            <p className="tiny muted">
              Submitted {formatDate(application.submittedAt, true)}
              {application.submissionSource === "autofill-copy" ? " · recorded when you copied the autofill script" : ""}
            </p>
          )}
          <ApplicationTracking
            key={`${application.id}:${application.version}`}
            application={application}
            mutate={mutate}
            justSaved={savedVersion === application.version}
            onSaved={setSavedVersion}
          />
        </>
      )}
      </div>
    </details>
  );
}
