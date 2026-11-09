import type { AppState } from "../../../shared/types";
import { openingVisibleInList } from "../../../shared/opening-availability";
import { greenhouseCompanyKey } from "../../../shared/greenhouse-company-filter";
import { postingIdentity } from "../../../shared/posting-url";

export type CompanyState = Pick<AppState, "openings" | "personal">;
export function guidanceCompanyOptions(state: CompanyState, includeArchived: boolean) {
  const openings = state.openings.filter(opening => includeArchived || (
    !state.personal[opening.id]?.dismissed && openingVisibleInList(opening, { closed: false, history: false })
  ));
  const counts = new Map<string, number>();
  const groups = new Map<string, { count: number; names: Map<string, number>; boards: Set<string> }>();
  for (const opening of openings) {
    const name = opening.company.trim();
    const key = greenhouseCompanyKey(name);
    if (!key) continue;
    const group = groups.get(key) ?? { count: 0, names: new Map<string, number>(), boards: new Set<string>() };
    group.count += 1;
    group.names.set(name, (group.names.get(name) ?? 0) + 1);
    const identity = postingIdentity(opening.url);
    const board = identity.ats === "greenhouse" ? identity.board ?? "" : "";
    if (board) group.boards.add(board);
    for (const alias of new Set([key, greenhouseCompanyKey(board)].filter(Boolean))) counts.set(alias, (counts.get(alias) ?? 0) + 1);
    groups.set(key, group);
  }
  const companies = [...groups].map(([id, group]) => ({
    id, count: group.count, boards: [...group.boards],
    label: [...group.names].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))[0][0],
  })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { companies, countExcluded: (name: string) => counts.get(greenhouseCompanyKey(name)) ?? 0 };
}
