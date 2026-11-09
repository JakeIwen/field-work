import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Personal } from "../../shared/types";

export function useOpeningDismissal(
  personal: (id: string, fields: Partial<Personal>) => Promise<unknown>,
  showDismissed: boolean,
  onHidden: (id: string) => void,
  onError: (message: string) => void,
) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const pending = useRef(new Set<string>());
  // An explicit filter change lets the user find previously dismissed openings.
  useEffect(() => { setHiddenIds(new Set(pending.current)); }, [showDismissed]);
  async function dismiss(id: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setHiddenIds(ids => new Set([...ids, id]));
    onHidden(id);
    try { await personal(id, { dismissed: true }); }
    catch (error) {
      setHiddenIds(ids => { const next = new Set(ids); next.delete(id); return next; });
      onError(`Could not mark this opening not interested: ${String(error)}. The row has been restored.`);
    } finally { pending.current.delete(id); }
  }
  return { hiddenIds, dismiss };
}

export function DismissOpeningButton({ id, label, dismiss }: { id: string; label: string; dismiss: (id: string) => Promise<void> }) {
  return <button type="button" className="icon-button" title="Not interested" aria-label={`Not interested in ${label}`}
    onClick={event => { event.stopPropagation(); void dismiss(id); }}><X size={15} aria-hidden="true" /></button>;
}
