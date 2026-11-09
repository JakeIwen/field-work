import type { AppState } from "../../shared/types";

export const monitored = (state: AppState) =>
  state.companies.filter((c) => state.personal[c.id]?.monitoring !== false);
