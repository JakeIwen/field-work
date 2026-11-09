import type { TunableSettings } from "../../shared/tunables";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Clock3, RotateCw } from "lucide-react";
import { useAppReload } from "./useAppReload";
import AppReloadBanner from "./AppReloadBanner";
import type { Go } from "../workspace/workspace-actions";

export default function ReloadAppButton({ onError, go, settings }: { onError: (message: string) => void; go: Go; settings?: TunableSettings }) {
  const { status, busy, request, cancel } = useAppReload(onError, settings);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setTarget(document.getElementById("app-reload-banner")); }, []);
  const waiting = !!status?.waiting;
  const label = waiting ? "Cancel reload when idle" : busy ? "Reloading app…" : "Reload app";
  return <>
    <button type="button" className={`icon-button reload-app-button${waiting ? " reload-pending" : ""}`} aria-label={label}
      title={waiting ? "Reload when idle is pending. Click again to cancel the pending reload." : "Reload app: stop running generations and restart the backend. Alt-click: Reload when idle, after current work finishes."} disabled={busy && !waiting}
      onClick={event => { if (waiting) void cancel(); else void request(event.altKey); }}>
      {waiting ? <Clock3 size={18} aria-hidden="true" /> : <RotateCw size={18} className={busy ? "spin" : undefined} aria-hidden="true" />}
    </button>
    {target && status && createPortal(<AppReloadBanner status={status} cancel={cancel} go={go} />, target)}
  </>;
}
