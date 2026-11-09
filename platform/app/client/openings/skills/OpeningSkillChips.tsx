import { Fragment } from "react";
import type { Opening } from "../../../shared/types";
import { openingSkillGroups } from "../../../shared/opening-skills";
import type { SkillFilter } from "./opening-skill-filter";
import { knownSkillsFirst, openingSkillMatch } from "./opening-skill-match";
import { useSkillChipLimit } from "./useSkillChipLimit";
import "./opening-skills.css";

export function OpeningSkillChips({ opening, filter, knownSkills = [] }: { opening: Opening; filter: SkillFilter; knownSkills?: readonly string[] }) {
  const known = new Set(knownSkills);
  const { required, anyOf, preferred } = openingSkillGroups(opening);
  const chip = (members: string[], preferred = false) => {
    const label = members.join(" / ");
    return { label, group: members.length > 1, preferred,
      known: members.some(skill => known.has(skill)), included: members.some(skill => filter.include.includes(skill)),
      content: members.length === 1 ? label : members.map((skill, index) => <Fragment key={skill}>{index > 0 && <> <span className="skill-or">/</span> </>}{skill}</Fragment>),
    };
  };
  const requiredChips = [...required.map(skill => chip([skill])), ...anyOf.map(group => chip(group))]
    .sort((a, b) => Number(b.known) - Number(a.known) || a.label.localeCompare(b.label, "en"));
  const skills = [...requiredChips, ...knownSkillsFirst(preferred, known).map(skill => chip([skill], true))];
  const { container, measure, visible, overflowOnNewRow } = useSkillChipLimit(skills.map(skill => skill.label).join("|"), skills.length);
  if (!skills.length) return <span className="small muted">Not specified</span>;
  const match = openingSkillMatch(opening, known);
  const summary = `${match.matched} of ${match.total}${preferred.length ? " required" : ""} skills on your resume${preferred.length ? ` · ${preferred.length} nice to have` : ""}`;
  const hidden = skills.slice(visible);
  const hiddenLabel = `More skills: ${hidden.map(skill => `${skill.label}${skill.group ? " (any one)" : skill.preferred ? " (nice to have)" : ""}`).join(", ")}`;
  const overflow = hidden.length > 0 && <span className="skill-chip skill-overflow" title={hiddenLabel} aria-label={hiddenLabel}>…</span>;
  return <div ref={container} className="opening-skill-chips" role="group" title={summary} aria-label={summary}>
    {skills.slice(0, visible).map(skill => <span key={skill.label}
      title={skill.group ? `Any one of these${skill.known ? " · on your resume" : ""}` : skill.preferred ? `Nice to have${skill.known ? " · on your resume" : ""}` : skill.known ? "On your resume" : undefined}
      className={`skill-chip${skill.group ? " skill-group" : ""}${skill.preferred ? " skill-preferred" : ""}${skill.known ? " skill-known" : ""}${skill.included ? " skill-included" : ""}`}>{skill.content}</span>)}
    {overflowOnNewRow ? <span className="skill-overflow-line">{overflow}</span> : overflow}
    <div ref={measure} className="skill-chip-measure" aria-hidden="true">
      {skills.map(skill => <span key={skill.label} className={`skill-chip${skill.group ? " skill-group" : ""}`}>{skill.content}</span>)}
      <span className="skill-chip">…</span>
    </div>
  </div>;
}
