import { useState } from "react";
import { readStored, writeStored } from "../workspace/browser-storage";
import { stageLabel } from "./stages";
import type { Application, ApplicationStatus } from "../../shared/types";

const stages: ApplicationStatus[] = ["considering", "preparing", "ready", "applied", "interviewing", "rejected"];
const stageKey = "fieldwork.applications.stage";

export function useApplicationVisibility(applications: Application[]) {
  const [stage, setStage] = useState<ApplicationStatus | "">(() => {
    const saved = readStored(stageKey);
    return stages.find(value => value === saved) || "";
  });
  const rejectedCount = applications.filter(application => application.status === "rejected").length;
  const visible = applications.filter(application => stage ? application.status === stage : application.status !== "rejected");
  const choose = (next: ApplicationStatus | "") => {
    setStage(next);
    writeStored(stageKey, next);
  };
  const control = <div className="stage-tabs" role="group" aria-label="Application stage">
    <button type="button" className={!stage ? "selected" : ""} aria-pressed={!stage} onClick={() => choose("")}>
      All applications <span>{applications.length - rejectedCount}</span>
    </button>
    {stages.map(value => <button key={value} type="button" className={stage === value ? "selected" : ""}
      aria-pressed={stage === value} onClick={() => choose(value)}>
      {stageLabel(value)} <span>{applications.filter(application => application.status === value).length}</span>
    </button>)}
  </div>;
  return { visible, control, stage, rejectedCount };
}
