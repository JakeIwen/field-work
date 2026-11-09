import type { OpeningFormQuestionCounts } from "../../shared/opening-form-check.js";
import { cachedStateRead } from "../storage-state-cache.js";
import { openingRecordKinds } from "../storage-openings.js";
import type { Store } from "../storage.js";
import { readAutofillProfile } from "./profile.js";

export function currentFormQuestionCounts(
  store: Store,
): Record<string, OpeningFormQuestionCounts> {
  const checks = cachedStateRead(
    store,
    "opening-form-checks",
    [...openingRecordKinds, "opening_form_check"],
    () => {
      const openings = new Map(
        store.openings().map((opening) => [opening.id, opening]),
      );
      return store
        .list("opening_form_check")
        .filter(
          (check) =>
            check.status === "ok" &&
            openings.get(check.openingId)?.hash === check.openingHash,
        );
    },
  );
  if (!checks.length) return {};
  // Profile includes files and derived age; Store versions cannot validate it.
  let profileHash: string;
  try {
    profileHash = readAutofillProfile(store).hash;
  } catch {
    return {};
  }
  return Object.fromEntries(
    checks
      .filter((check) => check.profileHash === profileHash)
      .map(({ openingId, personal, narrative }) => [
        openingId,
        { personal, narrative },
      ]),
  );
}
