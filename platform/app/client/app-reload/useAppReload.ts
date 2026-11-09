import { tunableValue, type TunableSettings } from "../../shared/tunables";
import { pollReloadStatus } from "./reload-status-poll";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppHealth, AppReloadStatus } from "../../shared/app-reload";
import { api } from "../workspace/api";
import { browserReloadTiming, waitForAppReload } from "./reload-app";

export function useAppReload(onError: (message: string) => void, settings: TunableSettings = {}) {
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const [status, setStatus] = useState<AppReloadStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const watching = useRef(false), requesting = useRef(false), revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const monitoring = useRef<AbortController | null>(null);
  const monitor = useCallback(async (receipt: AppReloadStatus) => {
    if (watching.current) return;
    watching.current = true; setBusy(true); setStatus(receipt);
    const current = new AbortController(); monitoring.current = current;
    const signal = controller.current ? AbortSignal.any([controller.current.signal, current.signal]) : current.signal;
    try {
      await waitForAppReload(receipt, { ...browserReloadTiming(() => settingsRef.current), signal, onStatus: setStatus,
        health: () => api<AppHealth>("/api/health", undefined, undefined, {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(tunableValue(settingsRef.current, "browser.reloadHealthTimeoutS") * 1000)]) : AbortSignal.timeout(tunableValue(settingsRef.current, "browser.reloadHealthTimeoutS") * 1000),
        }),
      });
    } catch (error) {
      if (!signal?.aborted) onError(error instanceof Error ? error.message : String(error));
    } finally { if (monitoring.current === current) { watching.current = false; monitoring.current = null; if (!signal.aborted) setBusy(false); } }
  }, [onError]);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    let fetching = false;
    const refresh = async () => {
      if (watching.current || requesting.current || fetching) return;
      fetching = true; const started = revision.current;
      try {
        const snapshot = await api<AppReloadStatus>("/api/system/reload", undefined, undefined, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(5000)]) });
        if (current.signal.aborted || started !== revision.current || watching.current || requesting.current) return;
        setStatus(snapshot);
        if (snapshot.waiting || snapshot.reloading) void monitor(snapshot);
      } finally { fetching = false; }
    };
    const stopPolling = pollReloadStatus(refresh, document, () => ({ baseDelayMs: tunableValue(settingsRef.current, "browser.reloadPollMs"), maximumDelayMs: tunableValue(settingsRef.current, "browser.reloadPollCapS") * 1000 }));
    return () => { current.abort(); stopPolling(); };
  }, [monitor]);
  async function request(whenIdle: boolean) {
    if (requesting.current || watching.current) return;
    requesting.current = true; revision.current++; setBusy(true);
    try {
      if (whenIdle) {
        const capability = await api<AppReloadStatus>("/api/system/reload");
        if (typeof capability.waiting !== "boolean") throw new Error("The backend needs updating before Reload when idle is available.");
      }
      const receipt = await api<AppReloadStatus>("/api/system/reload", { whenIdle });
      void monitor(receipt);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); setBusy(false); }
    finally { requesting.current = false; }
  }
  async function cancel() {
    revision.current++;
    try {
      const cancelled = await api<AppReloadStatus>("/api/system/reload/cancel", {});
      monitoring.current?.abort(); monitoring.current = null; watching.current = false;
      setStatus(cancelled); setBusy(false);
    }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return { status, busy, request, cancel };
}
