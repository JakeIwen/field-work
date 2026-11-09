import { Keyboard, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { openingListHelp, shortcutHelp } from "./navigation";

function ShortcutRows({ items }: { items: [string, string][] }) {
  return (
    <dl className="shortcut-list">
      {items.map(([key, label]) => (
        <div key={key}>
          <dt>
            {key.split(" ").map((part, index, parts) =>
              parts.length > 1 && (part === "then" || part === "/") ? (
                <span key={index} className="muted"> {part} </span>
              ) : (
                <kbd key={index}>{part}</kbd>
              ),
            )}
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      dialog.querySelector<HTMLButtonElement>(".shortcut-close")?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="shortcut-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="shortcut-body">
        <div className="shortcut-heading">
          <h2 id="shortcut-title"><Keyboard size={18} aria-hidden="true" /> Keyboard shortcuts</h2>
          <button type="button" className="icon-button shortcut-close" aria-label="Close keyboard shortcuts" title="Close keyboard shortcuts" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="small muted">Shortcuts are ignored while you type in a field.</p>
        <h3>Anywhere</h3>
        <ShortcutRows items={shortcutHelp} />
        <h3>Openings list</h3>
        <ShortcutRows items={openingListHelp} />
      </div>
    </dialog>
  );
}
