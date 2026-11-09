import type { Opening } from "../shared/types.js";
import {
  openingSkillListLimits,
  validOpeningSkills,
  type OpeningSkills,
} from "../shared/opening-skills.js";
import { HttpError } from "./storage.js";

const fieldNames = {
  required: "Required skills",
  preferred: "Preferred skills",
  anyOf: "Required skill groups",
};
const nameSchema = {
  type: "string",
  minLength: 1,
  maxLength: openingSkillListLimits.length,
  pattern: "^[^\\r\\n]+$",
};
const listSchema = {
  type: "array",
  maxItems: openingSkillListLimits.items,
  items: nameSchema,
};
export const schema = {
  type: "object",
  description:
    "Technologies, languages, frameworks, platforms, tools and services the posting names. required: those it treats as must-have qualifications or the role's day-to-day stack. preferred: those it marks preferred, nice to have, bonus, a plus, or familiarity-level. Use the posting's own names, one technology per item, no practices, methodologies or soft skills. anyOf: groups where any one member satisfies a requirement, for example Go, Python or Java; put such alternatives here, not under required. A technology the posting also requires on its own stays in required.",
  properties: {
    required: listSchema,
    preferred: listSchema,
    anyOf: {
      type: "array",
      maxItems: openingSkillListLimits.groups,
      items: {
        type: "array",
        minItems: 2,
        maxItems: openingSkillListLimits.groupMembers,
        items: nameSchema,
      },
    },
  },
  required: Object.keys(fieldNames),
  additionalProperties: false,
};

export function validate(value: unknown) {
  if (value !== undefined && !validOpeningSkills(value))
    throw new HttpError(
      422,
      `skills requires an object with required and preferred arrays, each containing at most ${openingSkillListLimits.items} names, and an optional anyOf array of at most ${openingSkillListLimits.groups} groups, each containing 1–${openingSkillListLimits.groupMembers} names. All names must be nonempty, single-line technology names of at most ${openingSkillListLimits.length} characters. Use one technology per item.`,
    );
}

type SkillSource = Pick<Opening, "hash" | "skills" | "skillsSourceHash">;
export function bind(opening: SkillSource, skills: OpeningSkills | undefined) {
  if (skills !== undefined) {
    opening.skills = skills;
    opening.skillsSourceHash = opening.hash;
  }
}

export function merge(
  combined: SkillSource,
  existing: SkillSource,
  research: SkillSource,
) {
  if (!existing.skills || existing.skillsSourceHash !== existing.hash)
    bind(combined, research.skills);
}

function names(
  value = "",
  separator: string | RegExp = ",",
  limit: number = openingSkillListLimits.items,
): string[] {
  return value
    .split(separator)
    .map((name) => name.trim())
    .filter(
      (name) =>
        !!name &&
        !/^unknown$/i.test(name) &&
        name.length <= openingSkillListLimits.length &&
        !/[\r\n]/.test(name),
    )
    .slice(0, limit);
}

export function parse(
  fields: Record<string, string>,
): OpeningSkills | undefined {
  if (!Object.values(fieldNames).some((key) => Object.hasOwn(fields, key)))
    return undefined;
  // The Markdown writer renders an empty field as "unknown"; it is not a skill.
  return {
    required: names(fields[fieldNames.required]),
    preferred: names(fields[fieldNames.preferred]),
    anyOf: (fields[fieldNames.anyOf] ?? "")
      .split(";")
      .map((group) =>
        names(group, /\s+or\s+/i, openingSkillListLimits.groupMembers),
      )
      .filter((group) => group.length)
      .slice(0, openingSkillListLimits.groups),
  };
}

export function supplement(o: SkillSource): [string, unknown][] {
  if (
    !validOpeningSkills(o.skills) ||
    (o.skillsSourceHash && o.skillsSourceHash !== o.hash)
  )
    return [];
  const extra: [string, unknown][] = [
    [fieldNames.required, o.skills.required.join(", ")],
    [fieldNames.preferred, o.skills.preferred.join(", ")],
  ];
  if (o.skills.anyOf?.length)
    extra.push([
      fieldNames.anyOf,
      o.skills.anyOf.map((group) => group.join(" or ")).join("; "),
    ]);
  return extra;
}
