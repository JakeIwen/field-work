import { accessSync, constants, readFileSync, statSync } from "node:fs";
import {
  currentResumePath,
  evidenceDossierPath,
} from "./application-evidence.js";
import { safeSource } from "./storage.js";
import { skillsInText } from "../shared/opening-skills.js";

type ResumeSource = { root: string };
type CachedSkills = {
  path: string;
  mtime: number;
  size: number;
  skills: string[];
};
const cached = new WeakMap<ResumeSource, Map<string, CachedSkills>>();

// The user keeps skills that rarely make the resume on this one dossier line; the rest of
// the dossier mentions technologies as gaps and cautions, so it is not scanned.
const additionalSkillsLine = /^\*\*Additional known skills:\*\*(.*)$/gm;
const dossierSkills = (text: string) =>
  skillsInText(
    [...text.matchAll(additionalSkillsLine)]
      .map((match) => match[1].split(",").join("\n"))
      .join("\n"),
  );

/** Edits refresh on the next state request, without re-parsing every response. */
function skillsInSource(
  source: ResumeSource,
  relative: string,
  extract: (text: string) => string[],
): string[] {
  const files = cached.get(source) ?? new Map<string, CachedSkills>();
  cached.set(source, files);
  try {
    const file = safeSource(source.root, relative);
    const stat = statSync(file);
    accessSync(file, constants.R_OK);
    const prior = files.get(relative);
    if (
      prior?.path === file &&
      prior.mtime === stat.mtimeMs &&
      prior.size === stat.size
    )
      return prior.skills;
    const skills = extract(readFileSync(file, "utf8"));
    files.set(relative, {
      path: file,
      mtime: stat.mtimeMs,
      size: stat.size,
      skills,
    });
    return skills;
  } catch {
    // Missing or unreadable evidence must not leave a stale claim of a match.
    files.delete(relative);
    return [];
  }
}

/** Catalog skills in the current resume plus the dossier's additional known skills. */
export function resumeSkills(source: ResumeSource): string[] {
  return [
    ...new Set([
      ...skillsInSource(source, currentResumePath, skillsInText),
      ...skillsInSource(source, evidenceDossierPath, dossierSkills),
    ]),
  ].sort((a, b) => a.localeCompare(b, "en"));
}
