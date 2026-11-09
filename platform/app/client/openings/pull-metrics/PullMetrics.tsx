import React, { useState } from "react";
import type { Go } from "../../workspace/workspace-actions";
import { PullMetricsPanel } from "./PullMetricsPanel";
import "./pull-metrics.css";

export function PullMetrics({ go }: { go: Go }) {
  const [opened, setOpened] = useState(false);
  return <details className="pull-metrics intake-summary" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>Pull metrics</summary>
    {opened && <PullMetricsPanel go={go} />}
  </details>;
}
