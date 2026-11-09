import { openingSkillGroups } from "../../../shared/opening-skills";
import type { Opening } from "../../../shared/types";

export type SkillMatch = { matched: number; total: number; fraction: number };

export function openingSkillMatch(opening: Opening, known: ReadonlySet<string>): SkillMatch {
  const { required, anyOf } = openingSkillGroups(opening);
  const total = required.length + anyOf.length;
  const matched = required.filter(skill => known.has(skill)).length + anyOf.filter(group => group.some(skill => known.has(skill))).length;
  return { matched, total, fraction: total ? matched / total : 0 };
}

export function knownSkillsFirst(skills: readonly string[], known: ReadonlySet<string>): string[] {
  return [...skills].sort((a, b) => Number(known.has(b)) - Number(known.has(a)) || a.localeCompare(b, "en"));
}

export function skillMatchOrder(a: SkillMatch, b: SkillMatch, byCount = false): number {
  if (!a.total || !b.total) return Number(!a.total) - Number(!b.total);
  const percent = b.fraction - a.fraction;
  const count = b.matched - a.matched;
  return byCount ? count || percent : percent || count;
}
