import { Clock3, LoaderCircle, X } from "lucide-react";
import AppLink from "../ui/AppLink";
import type { AppReloadStatus } from "../../shared/app-reload";
import type { Go } from "../workspace/workspace-actions";
import "./app-reload.css";

export default function AppReloadBanner({ status, cancel, go }: { status: AppReloadStatus; cancel: () => void; go: Go }) {
  if (!status.waiting && !status.reloading) return null;
  return <div className="banner reload-banner" role="status" aria-live="polite">
    {status.waiting ? <Clock3 size={18} aria-hidden="true" /> : <LoaderCircle size={18} className="spin" aria-hidden="true" />}
    <div className="reload-banner-content">
      <strong>{status.waiting ? `Reload when idle · ${status.remaining.length} remaining` : "Reloading app…"}</strong>
      {status.waiting && <ul>{status.remaining.map(item => <li key={item.id}>
        {item.page ? <AppLink go={go} page={item.page} id={item.recordId}>{item.label}</AppLink> : <span>{item.label}</span>}
        <span className="muted"> · {item.detail}</span>
      </li>)}</ul>}
    </div>
    {status.waiting && <button type="button" className="icon-button" title="Cancel reload when idle" aria-label="Cancel reload when idle" onClick={cancel}><X size={16} /></button>}
  </div>;
}
