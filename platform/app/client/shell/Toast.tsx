import { tunables } from "../../shared/tunables";
import { AlertTriangle, Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Go, NoticeMessage } from "../workspace/workspace-actions";
import AppLink from "../ui/AppLink";

export type Notice = NoticeMessage & { id: number };

export function Toast({ notice, onClose, go, seconds = tunables["browser.toastSeconds"].default }: { notice: Notice; onClose: (id: number) => void; go: Go; seconds?: number }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onClose(notice.id), seconds * 1000);
    return () => clearTimeout(timer);
  }, [notice.id, paused, onClose, seconds]);

  return (
    <div
      className="toast shell-toast"
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose(notice.id);
      }}
    >
      {notice.tone === "attention" ? <AlertTriangle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
      <div className="toast-content">
        <span>{notice.text}</span>
        {notice.links?.length === 1 && !notice.more ? <>
          <AppLink go={go} page={notice.links[0].page} id={notice.links[0].id}>{notice.links[0].label}</AppLink>
          {notice.links[0].detail && <span> — {notice.links[0].detail}</span>}
        </> : notice.links && <ul className="toast-links">
          {notice.links.map((link, index) => <li key={index}>
            <AppLink go={go} page={link.page} id={link.id}>{link.label}</AppLink>
            {link.detail && <span> · {link.detail}</span>}
          </li>)}
          {!!notice.more && <li>and {notice.more} more</li>}
        </ul>}
        {notice.suffix && <span>{notice.suffix}</span>}
      </div>
      <button type="button" className="icon-button toast-close" aria-label="Dismiss notification" title="Dismiss notification" onClick={() => onClose(notice.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
