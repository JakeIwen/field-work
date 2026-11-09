import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./GuidancePopup.css";

export function GuidancePopup({ title, children, onClose }: {
  title: string; children: ReactNode; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="guidance-popup" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onSubmit={event => event.stopPropagation()}>
    <div className="guidance-popup-heading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label={`Close ${title}`} title={`Close ${title}`} onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </div>
    {children}
  </dialog>, document.body);
}
