import { useEffect, useState } from "react";
import { preparationBusy, type ApplicationPreparation, type PreparationActivityResponse } from "../../shared/application-preparation";
import { api } from "../workspace/api";
import { useVisiblePoll } from "../workspace/useVisiblePoll";

/**
 * Live turns live in the server's memory and are never published, so they are read, not pushed.
 * Deliberately not a Settings tunable (the owner's approved exception, 2026-11-07): one small GET per
 * visible busy Opening, kept above the 3 s state-refetch spacing so the two never stack.
 */
const PREPARATION_ACTIVITY_INTERVAL_MS = 5000;

/**
 * The Opening's live preparation view, polled only while its run is busy and the tab is visible.
 * State snapshots already carry the run and the tasks' saved activity; this adds what only a
 * running turn knows (thinking, writing, retrying).
 */
export function usePreparationActivity(openingId: string, run?: ApplicationPreparation) {
  const busy = preparationBusy(run);
  const [answer, setAnswer] = useState<{ openingId: string; response: PreparationActivityResponse } | null>(null);
  useEffect(() => { if (!busy) setAnswer(null); }, [busy]);
  useVisiblePoll<PreparationActivityResponse>({
    enabled: busy, intervalMs: PREPARATION_ACTIVITY_INTERVAL_MS, continueInitially: true, deps: [openingId, run?.id],
    poll: signal => api<PreparationActivityResponse>(`/api/openings/${encodeURIComponent(openingId)}/preparation/activity`, undefined, undefined, { signal }),
    onResult: response => {
      setAnswer({ openingId, response });
      // The run settling is the stop signal; a missing run ends it too.
      return !!response.run && ["queued", "running", "waiting"].includes(response.run.status);
    },
  });
  return busy && answer?.openingId === openingId ? answer.response : null;
}

/** Wall-clock milliseconds, refreshed every second while `active`, so elapsed figures tick between polls. */
export function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}
