import { isActiveOpening } from "../../shared/opening-availability";
import type { AppState } from "../../shared/types";

export const retained = (state: AppState) =>
  state.openings.filter(isActiveOpening);
