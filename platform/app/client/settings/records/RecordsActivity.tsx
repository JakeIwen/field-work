import { useState } from "react";
import { tunableValue, type TunableSettings } from "../../../shared/tunables";
import type { Go } from "../../workspace/workspace-actions";
import RecordManager from "../RecordManager";
import { ActivityBrowser } from "./ActivityBrowser";
import "./records-activity.css";

export function RecordsActivity({ go, settings = {} }: { go: Go; settings?: TunableSettings }) {
  const [view, setView] = useState<"records" | "activity">("records");
  return <div className="panel-body records-activity">
    <div className="row-wrap" role="group" aria-label="Records and activity view">
      <button type="button" className={`button ${view === "records" ? "primary" : "secondary"}`}
        aria-pressed={view === "records"} onClick={() => setView("records")}>Saved records</button>
      <button type="button" className={`button ${view === "activity" ? "primary" : "secondary"}`}
        aria-pressed={view === "activity"} onClick={() => setView("activity")}>Activity</button>
    </div>
    {view === "records" ? <RecordManager go={go} pageSize={tunableValue(settings, "records.catalogPageSize")} /> : <ActivityBrowser go={go} pageSize={tunableValue(settings, "records.activityPageSize")} />}
  </div>;
}
