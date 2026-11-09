// Public compatibility exports: existing callers and immutable Greenhouse scripts keep their contracts.
export { greenhouseForm } from "./greenhouse-form.js";
export { buildAutofillPlan } from "./greenhouse-autofill-plan.js";
export { suggestAutofill } from "./suggest-autofill-rules.js";
export { readAutofillProfile } from "./autofill/profile.js";
export { generateAutofill } from "./application-autofill.js";
export { savedAutofills } from "./autofill/validity.js";
import { existsSync, readFileSync } from "node:fs";
import { Store, HttpError, sha256 } from "./storage.js";
import type { AutofillRecord } from "../shared/greenhouse-autofill.js";

export function savedAutofillScript(
  store: Store,
  openingId: string,
  id: string,
) {
  const record = store.get("application_autofill", id) as
    AutofillRecord | undefined;
  if (!record || record.openingId !== openingId || !store.opening(openingId))
    throw new HttpError(404, "Saved autofill script not found");
  const file = store.objectPath(record.scriptHash);
  if (!existsSync(file))
    throw new HttpError(
      404,
      "The saved script file is missing. Generate a new version.",
    );
  const script = readFileSync(file, "utf8");
  if (sha256(script) !== record.scriptHash)
    throw new HttpError(
      409,
      "Saved script integrity check failed. Generate a new version.",
    );
  return { record, script };
}
