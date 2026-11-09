import type { AppState } from "../../shared/types";
import { emptyOpeningFilters, filterOpenings } from "../openings/opening-filters";

export function NavigationCount({ id, state, visibleOpeningCount }: {
  id: string;
  state: AppState;
  visibleOpeningCount?: number | null;
}) {
  if (id !== "openings" && id !== "applications") return null;
  const count = id === "openings"
    ? visibleOpeningCount ?? filterOpenings(state, emptyOpeningFilters).length
    : state.applications.filter(application => application.status === "applied" || application.status === "interviewing").length;
  return <span className="nav-count"
    title={id === "applications" ? "Applied and interviewing applications" : "Openings in the current view"}>
    {count}
  </span>;
}
