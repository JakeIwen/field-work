import { useEffect, useRef } from "react";
import type { ApplicationPreparation } from "../../shared/application-preparation";
import type { AppState } from "../../shared/types";
import type { Notify } from "../workspace/workspace-actions";
import { preparationNotice } from "./preparation-notices";

export function usePreparationNotices(state: AppState | null, notify: Notify) {
  const previous = useRef<ApplicationPreparation[] | null>(null);
  useEffect(() => {
    if (!state) return;
    const notice = preparationNotice(previous.current, state);
    previous.current = state.preparations ?? [];
    if (notice) notify(notice.text, notice);
  }, [state, notify]);
}
