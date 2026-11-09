import type { Opening } from "./types";
import { openingSkillCatalog } from "./opening-skill-catalog";

export type OpeningSkillFilter = {
  include: string[];
  exclude: string[];
  match: "any" | "all";
};

const definitions = openingSkillCatalog.map(
  ([name, aliases = [], mention]) => ({
    name,
    aliases: [name, ...aliases],
    // Word boundaries alone lose punctuation-ending names such as C++ and C#.
    mention:
      mention ??
      new RegExp(
        `(?<![\\w.])(?:${[name, ...aliases].map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})(?![\\w])`,
        "i",
      ),
  }),
);
/**
 * Technologies the research agent classified from the posting. `required` are needed one by one,
 * `anyOf` holds groups where any one member satisfies a requirement ("Go, Python or Java"), and
 * `preferred` are nice to have. `anyOf` is optional for records saved before groups existed.
 */
export type OpeningSkills = {
  required: string[];
  preferred: string[];
  anyOf?: string[][];
};
/** The resolved view: canonical names, groups always present. */
export type OpeningSkillGroups = {
  required: string[];
  anyOf: string[][];
  preferred: string[];
};
export const openingSkillListLimits = {
  items: 60,
  length: 60,
  groups: 20,
  groupMembers: 10,
} as const;
const skillListKeys = ["required", "preferred"] as const;

const validSkillName = (item: unknown) =>
  typeof item === "string" &&
  !!item.trim() &&
  item.length <= openingSkillListLimits.length &&
  !/[\r\n]/.test(item);

export function validOpeningSkills(value: unknown): value is OpeningSkills {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const lists = skillListKeys.every((key) => {
    const list = record[key];
    return (
      Array.isArray(list) &&
      list.length <= openingSkillListLimits.items &&
      list.every(validSkillName)
    );
  });
  if (!lists) return false;
  const groups = record.anyOf;
  if (groups === undefined) return true;
  return (
    Array.isArray(groups) &&
    groups.length <= openingSkillListLimits.groups &&
    groups.every(
      (group) =>
        Array.isArray(group) &&
        group.length >= 1 &&
        group.length <= openingSkillListLimits.groupMembers &&
        group.every(validSkillName),
    )
  );
}

type SkillSource = Pick<Opening, "requirements"> &
  Partial<Pick<Opening, "skills" | "skillsSourceHash" | "hash">>;
const cached = new WeakMap<
  object,
  { source: string; groups: OpeningSkillGroups }
>();
const byName = (a: string, b: string) => a.localeCompare(b, "en");

/**
 * Required, any-of and preferred catalog skills. Classified lists bound to the current posting
 * hash win; otherwise every technology mentioned in the requirements counts as required, as before.
 * Names outside the catalog are dropped, as they are from postings. A group that shrinks to one
 * name becomes a plain requirement; a group containing an individually required name is implied by
 * it and dropped; a preferred name already required or grouped is dropped.
 */
export function openingSkillGroups(opening: SkillSource): OpeningSkillGroups {
  const classified =
    validOpeningSkills(opening.skills) &&
    (!opening.skillsSourceHash || opening.skillsSourceHash === opening.hash)
      ? opening.skills
      : undefined;
  const source = classified
    ? JSON.stringify(classified)
    : opening.requirements || "";
  const prior = cached.get(opening);
  if (prior?.source === source) return copy(prior.groups);
  const groups = classified
    ? resolveClassified(classified)
    : { required: skillsInText(source), anyOf: [], preferred: [] };
  cached.set(opening, { source, groups });
  return copy(groups);
}
function resolveClassified(classified: OpeningSkills): OpeningSkillGroups {
  // One name per line, so single-token names such as Go, C and R match their line-anchored patterns.
  const required = new Set(skillsInText(classified.required.join("\n")));
  const canonicalGroups = (classified.anyOf ?? []).map((group) =>
    skillsInText(group.join("\n")),
  );
  for (const group of canonicalGroups)
    if (group.length === 1) required.add(group[0]);
  const seen = new Set<string>();
  const anyOf: string[][] = [];
  for (const group of canonicalGroups) {
    if (group.length < 2 || group.some((name) => required.has(name))) continue;
    const key = group.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    anyOf.push(group);
  }
  const grouped = new Set(anyOf.flat());
  const preferred = skillsInText(classified.preferred.join("\n")).filter(
    (name) => !required.has(name) && !grouped.has(name),
  );
  return { required: [...required].sort(byName), anyOf, preferred };
}
const copy = (groups: OpeningSkillGroups): OpeningSkillGroups => ({
  required: [...groups.required],
  anyOf: groups.anyOf.map((group) => [...group]),
  preferred: [...groups.preferred],
});

/** Every chip name for the Opening: required, group members and preferred, for filters and the picker. */
export function openingSkills(opening: SkillSource): string[] {
  const { required, anyOf, preferred } = openingSkillGroups(opening);
  return anyOf.length || preferred.length
    ? [...new Set([...required, ...anyOf.flat(), ...preferred])].sort(byName)
    : required;
}

/** Match the same canonical technologies in postings and resume evidence. */
export function skillsInText(source: string): string[] {
  // Link targets and markup are not evidence that the role uses a technology.
  const text = source
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s<>]+/gi, " ")
    .replace(/<[^>]+>/g, " ")
    // Requirements can contain the entire posting, including customer/investor lists.
    .replace(
      /[^\n.!?]*(?:\bour (?:customers?|clients?) include\b|\b(?:venture[- ]backed by|funding from)\b|\bbacked by\b(?=[^\n.!?]*\b(?:investors?|ventures?|capital|funding|financing)\b|\s*[$€£]\s*\d)|\binvestors? includ(?:e|ing)\b)(?:\b(?:Inc|Corp|Ltd|Co)\.|[^\n.!?])*/gi,
      " ",
    );
  return definitions
    .filter((skill) => skill.mention.test(text))
    .map((skill) => skill.name)
    .sort((a, b) => a.localeCompare(b, "en"));
}

const searchable = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9+#]/g, "");

/** The picker accepts familiar spellings while keeping one canonical chip name. */
export function skillMatchesQuery(skill: string, query: string): boolean {
  const term = searchable(query);
  const definition = definitions.find((item) => item.name === skill);
  return (definition?.aliases ?? [skill]).some((alias) =>
    searchable(alias).includes(term),
  );
}
