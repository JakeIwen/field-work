import { api } from "../workspace/api";
import { formatDate } from "../ui/dates";
import React, {useEffect, useRef, useState} from 'react';

export default function TaskEvents({taskId, version}: {taskId: string; version?: number;}) {
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const currentVersion = useRef(version);
  currentVersion.current = version;
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false, loaded = false;
    let fetchedVersion: number | undefined;
    const read = async () => {
      if (inFlight || loaded && fetchedVersion === currentVersion.current) return;
      inFlight = true;
      const requestedVersion = currentVersion.current;
      try {
        const response = await api(`/api/tasks/${encodeURIComponent(taskId)}/events`, undefined, undefined, {
          responseType: 'response',
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load progress events.');
        if (!controller.signal.aborted) {
          setEvents(data.events); setError(''); setLoading(false);
          loaded = true; fetchedVersion = requestedVersion;
        }
      } catch (e) {
        if (!controller.signal.aborted) {setError(e instanceof Error ? e.message : String(e)); setLoading(false);}
      } finally {inFlight = false;}
    };
    void read();
    const timer = setInterval(read, 1000);
    return () => {clearInterval(timer); controller.abort();};
  }, [taskId]);
  return <div className="event-log">
    {loading && <p role="status">Loading progress events…</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {events.map((e, i) => <details key={i}>
      <summary><span>{e.method}</span><small>{formatDate(e.at, true)}</small></summary>
      <pre>{JSON.stringify(e.params, null, 2)}</pre>
    </details>)}
  </div>;
}
