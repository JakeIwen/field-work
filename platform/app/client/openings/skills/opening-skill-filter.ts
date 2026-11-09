import type { OpeningSkillFilter } from "../../../shared/opening-skills";
export type SkillFilter = OpeningSkillFilter;
export const emptySkillFilter: SkillFilter = { include: [], exclude: [], match: "any" };

export function normalizeSkillFilter(value: unknown): SkillFilter {
  const filter = value && typeof value === "object" ? value as Partial<SkillFilter> : {};
  const strings = (items: unknown) => Array.isArray(items)
    ? [...new Set(items.filter((item): item is string => typeof item === "string" && !!item.trim()))] : [];
  const exclude = strings(filter.exclude);
  return { include: strings(filter.include).filter(skill => !exclude.includes(skill)), exclude, match: filter.match === "all" ? "all" : "any" };
}

export function matchesSkillFilter(skills: readonly string[], filter: SkillFilter): boolean {
  if (filter.exclude.some(skill => skills.includes(skill))) return false;
  return !filter.include.length || (filter.match === "all"
    ? filter.include.every(skill => skills.includes(skill))
    : filter.include.some(skill => skills.includes(skill)));
}

export function toggleSkill(filter: SkillFilter, skill: string, mode: "include" | "exclude"): SkillFilter {
  const selected = filter[mode].includes(skill);
  const next = { ...filter, include: filter.include.filter(item => item !== skill), exclude: filter.exclude.filter(item => item !== skill) };
  if (!selected) next[mode] = [...next[mode], skill];
  return next;
}
