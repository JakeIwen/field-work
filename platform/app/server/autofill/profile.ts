import { readFileSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { Store, HttpError, safeSource, sha256 } from "../storage.js";
import { educationFromResume, experienceFromResume } from "./resume-facts.js";
import { ageFromBirthDate } from "./profile-answers.js";
import { currentResumePath as resumePath } from "../../shared/workspace-sources.js";
import { confirmedEducation } from "./education.js";

export function readAutofillProfile(store: Store) {
  const file = path.join(store.root, ".local/greenhouse/profile.json");
  if (!existsSync(file))
    throw new HttpError(
      422,
      "Save your reusable application answers before generating an autofill script.",
    );
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 50000)
    throw new HttpError(
      422,
      "The saved application profile is not a supported local JSON file.",
    );
  try {
    const profile = JSON.parse(readFileSync(file, "utf8"));
    if (
      !profile ||
      typeof profile !== "object" ||
      Array.isArray(profile) ||
      profile.version !== 1
    )
      throw Error();
    delete profile.resumeFacts;
    if (profile.education != null && !confirmedEducation(profile.education))
      throw new Error("Invalid confirmed education");
    // Derived age changes the profile hash on birthdays, invalidating old scripts.
    profile.age = ageFromBirthDate(profile.dateOfBirth);
    if (existsSync(path.join(store.root, resumePath))) {
      const resume = readFileSync(safeSource(store.root, resumePath), "utf8");
      profile.resumeFacts = {
        ...educationFromResume(resume, profile.school),
        experience: experienceFromResume(resume),
        sourcePath: resumePath,
        sourceHash: sha256(resume),
      };
    }
    return { profile, hash: sha256(JSON.stringify(profile)) };
  } catch {
    throw new HttpError(
      422,
      "The saved application profile is invalid. Correct it before generating a script.",
    );
  }
}
