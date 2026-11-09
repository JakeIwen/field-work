import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Opening } from "../../shared/types";
import type { Go } from "../workspace/workspace-actions";
import { hasModifier, isTypingTarget } from "../shell/keys";

export function useOpeningRangeSelection(rows: Opening[], setSelection: Dispatch<SetStateAction<string[]>>) {
  const anchor = useRef<string | null>(null);
  const toggleSelected = (id: string, checked: boolean, shift = false) => {
    const start = rows.findIndex(row => row.id === anchor.current);
    const end = rows.findIndex(row => row.id === id);
    const ids = shift && start >= 0 && end >= 0
      ? rows.slice(Math.min(start, end), Math.max(start, end) + 1).map(row => row.id) : [id];
    if (!shift || start < 0) anchor.current = id;
    setSelection(selected => checked ? [...new Set([...selected, ...ids])] : selected.filter(value => !ids.includes(value)));
  };
  return { toggleSelected, resetSelectionAnchor: () => { anchor.current = null; } };
}

type KeyboardOptions = {
  rows: Opening[];
  focusId: string;
  chosenId?: string;
  comparing: boolean;
  go: Go;
  setFocusId: (id: string) => void;
  setComparing: (value: boolean) => void;
  setSelection: Dispatch<SetStateAction<string[]>>;
};

function handleOpeningKey(event: KeyboardEvent, options: KeyboardOptions) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const row = target?.closest<HTMLElement>("tr[data-opening-id]");
  const checkbox = target?.matches("input[type='checkbox']") && row;
  if (event.defaultPrevented || hasModifier(event) || (isTypingTarget(target) && !checkbox)) return;
  if ([...document.querySelectorAll("[role='dialog'], dialog[open], .sidebar.mobile-open")]
    .some(element => element.getClientRects().length > 0)) return;
  const { rows, focusId, chosenId, comparing, go, setFocusId, setComparing, setSelection } = options;
  if (event.key === "Escape") {
    if (comparing) setComparing(false);
    else if (chosenId) go("openings");
    return;
  }
  // Leave controls and detail content to their native keyboard interactions.
  if (!row && target?.closest("input, button, a, summary, .opening-detail-panel")) return;
  const index = rows.findIndex(o => o.id === (row?.dataset.openingId || focusId));
  switch (event.key) {
    case "ArrowDown": case "ArrowUp": case "j": case "k": {
      if (!rows.length || event.shiftKey) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" || event.key === "j" ? 1 : -1;
      const start = index >= 0 ? index + step : Math.max(0, rows.findIndex(o => o.id === chosenId));
      const id = rows[Math.min(rows.length - 1, Math.max(0, start))].id;
      setFocusId(id);
      const next = document.querySelector(`tr[data-opening-id="${CSS.escape(id)}"]`);
      next?.querySelector<HTMLElement>(checkbox ? "input[type='checkbox']" : "a.table-role")?.focus({ preventScroll: true });
      next?.scrollIntoView({ block: "nearest" });
      return;
    }
    case "Enter": case "o":
      if (index < 0 || (event.key === "Enter" && target?.closest("a, button, input, summary, [role='button']"))) return;
      event.preventDefault();
      go("openings", rows[index].id);
      return;
    case "x":
      if (index < 0) return;
      event.preventDefault();
      setSelection(ids => ids.includes(rows[index].id) ? ids.filter(id => id !== rows[index].id) : [...ids, rows[index].id]);
  }
}

export function useOpeningListKeyboard(options: KeyboardOptions) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => handleOpeningKey(event, latest.current);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}
