import type { OpeningSort } from "../opening-sort";

const modes = {
  "skills-percent": { label: "% match · highest first", next: "skills-count", nextLabel: "# matched" },
  "skills-count": { label: "# matched · most first", next: "skills-percent", nextLabel: "% match" },
} as const satisfies Partial<Record<OpeningSort, { label: string; next: OpeningSort; nextLabel: string }>>;

export function OpeningSkillsSortHeader({ sort, onSort }: { sort: OpeningSort; onSort: (sort: OpeningSort) => void }) {
  const mode = Object.hasOwn(modes, sort) ? modes[sort as keyof typeof modes] : undefined;
  return <th className="opening-skills-col" aria-sort={mode ? "descending" : "none"}>
    <button className="opening-sort-header opening-fit-sort-header"
      title="Cycle sorting: % of required posting skills on your resume → number matched. Each any-of group counts once and is met by any member. Nice-to-have skills are dimmed and not counted. Openings with no recognized required skills stay last."
      aria-label={`Skills. ${mode ? `Sorted by ${mode.label}. ` : ""}Sort next by ${mode?.nextLabel ?? "% match"}`}
      onClick={() => onSort(mode?.next ?? "skills-percent")}>
      <span>Skills <span aria-hidden="true">↻</span></span>
      {mode && <span className="opening-fit-sort-label">{mode.label}</span>}
    </button>
  </th>;
}
