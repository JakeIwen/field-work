import { useEffect, useState } from "react";
import { api } from "../../workspace/api";
import { pullMetricsPath, type PullMetricsQuery, type PullMetricsResponse } from "../../../shared/greenhouse-pull-metrics";

export function metricsUrl(query: Partial<PullMetricsQuery>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return `${pullMetricsPath}?${params}`;
}
export function usePullMetrics(query: Partial<PullMetricsQuery>, enabled = true) {
  const url = metricsUrl(query);
  const [data, setData] = useState<PullMetricsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setLoading(true); setError(""); setData(null);
    api(url).then(result => { if (current) setData(result); })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [url, enabled, revision]);
  return { data, error, loading, refresh: () => setRevision(value => value + 1) };
}
