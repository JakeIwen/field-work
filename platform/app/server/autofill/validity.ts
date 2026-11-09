import { cachedRead, withReadCache } from "../storage-read-cache.js";
import {
  autofillPreparationView,
  type AutofillHistoryRecord,
  type AutofillRecord,
} from "../../shared/greenhouse-autofill.js";
import type {
  ApplicationPreparation,
  AnswersOnlyAutofillCount,
} from "../../shared/application-preparation.js";
import { documentWritingWarning } from "../document-writing-status.js";
import { type Store, HttpError } from "../storage.js";
import { readAutofillProfile } from "./profile.js";
import { autofillAnswerValidity } from "./saved-answers.js";
import { retiredJobBoard } from "../../shared/posting-url.js";
import { sameHostedApplication } from "../../shared/application-host.js";
import { preparationDocument } from "../preparation-documents.js";

export function savedAutofills(
  store: Store,
  openingId: string,
  latestOnly = false,
) {
  return withReadCache(store, () =>
    readSavedAutofills(store, openingId, latestOnly),
  );
}

function readSavedAutofills(
  store: Store,
  openingId: string,
  latestOnly: boolean,
) {
  const opening = store.opening(openingId);
  if (!opening) throw new HttpError(404, "Opening not found");
  let profileHash = "";
  try {
    profileHash = readAutofillProfile(store).hash;
  } catch {
    /* Existing downloads remain available. */
  }
  const answersAreCurrent = autofillAnswerValidity(store);
  const rows = store.db
    .prepare(
      `SELECT json FROM records WHERE kind='application_autofill'
    AND json_extract(json, '$.openingId')=? ORDER BY rowid DESC${latestOnly ? " LIMIT 1" : ""}`,
    )
    .all(openingId);
  return rows
    .map((row) => JSON.parse(String(row.json)) as AutofillRecord)
    .map((r) => {
      const staleReasons: string[] = [];
      if (r.profileHash !== profileHash)
        staleReasons.push("Saved profile answers changed.");
      if (r.openingHash !== opening.hash)
        staleReasons.push("Opening details changed.");
      if (retiredJobBoard(r.url))
        staleReasons.push(
          "This autofill provider is retired. The saved script remains available for download.",
        );
      else if (!sameHostedApplication(r.url, opening.url))
        staleReasons.push("The application URL changed.");
      for (const a of r.attachments ?? []) {
        try {
          const { doc } = preparationDocument(store, openingId, a.documentId);
          const warning = documentWritingWarning(store, doc);
          if (warning) staleReasons.push(warning);
        } catch (error) {
          staleReasons.push(
            error instanceof HttpError
              ? error.message
              : "A saved PDF is missing or could not be checked.",
          );
        }
      }
      if (!answersAreCurrent(r))
        staleReasons.push("Evidence used for written answers changed.");
      return {
        ...r,
        stale: staleReasons.length > 0,
        staleReasons: [...new Set(staleReasons)],
      };
    });
}

/** One latest-script read feeds both preparation freshness and the list counts. */
function latestAutofillRecords(store: Store): Map<string, AutofillRecord> {
  return cachedRead(store, "latest-autofill-records", () => {
    const rows = store.db
      .prepare(
        `SELECT json FROM records WHERE rowid IN (SELECT max(rowid) FROM records
      WHERE kind='application_autofill' GROUP BY json_extract(json, '$.openingId'))`,
      )
      .all();
    return new Map(
      rows.map(({ json }) => {
        const record = JSON.parse(String(json)) as AutofillRecord;
        return [record.openingId, record];
      }),
    );
  });
}

/**
 * The Opening's newest saved script when it still describes the Opening's
 * current posting and application form: the same two identity checks
 * `readSavedAutofills` uses for "Opening details changed" and "The
 * application URL changed". Read from the request-cached latest-script map.
 */
export function currentOpeningAutofill(
  store: Store,
  opening: { id: string; hash: string; url: string },
): AutofillRecord | undefined {
  const record = latestAutofillRecords(store).get(opening.id);
  return record &&
    record.openingHash === opening.hash &&
    sameHostedApplication(record.url, opening.url)
    ? record
    : undefined;
}

export function answersPreparationStaleReasons(
  store: Store,
  run: ApplicationPreparation,
): string[] {
  const record = latestAutofillRecords(store).get(run.openingId);
  if (!record) return ["The saved autofill script is missing."];
  const reasons: string[] = [];
  if (record.openingHash !== store.opening(run.openingId)?.hash)
    reasons.push("Opening details changed.");
  try {
    const profileHash = cachedRead(
      store,
      "autofill-preparation-profile-hash",
      () => readAutofillProfile(store).hash,
    );
    if (record.profileHash !== profileHash)
      reasons.push("Saved profile answers changed.");
    const valid = cachedRead(store, "autofill-answer-validity", () =>
      autofillAnswerValidity(store),
    );
    if (!valid(record))
      reasons.push("Evidence used for written answers changed.");
  } catch {
    reasons.push("Saved profile or answer evidence could not be checked.");
  }
  if (record.answerError) reasons.push(record.answerError);
  return reasons;
}

/** Keep complete-script counts unchanged; answer-only counts omit just the two generated uploads. */
export function openingAutofillCounts(
  store: Store,
  preparations: ApplicationPreparation[],
) {
  const runs = new Map(preparations.map((run) => [run.openingId, run]));
  const openingAutofillFinishCounts: Record<string, number> = {};
  const openingAutofillAnswerCounts: Record<string, AnswersOnlyAutofillCount> =
    {};
  for (const record of latestAutofillRecords(store).values()) {
    const view = autofillPreparationView(record, runs.get(record.openingId));
    if (view.answersOnly)
      openingAutofillAnswerCounts[record.openingId] = {
        scope: "answers",
        count: view.answersOnlyFinishItems.length,
      };
    else if (!view.incomplete)
      openingAutofillFinishCounts[record.openingId] = view.finishItems.length;
  }
  return { openingAutofillFinishCounts, openingAutofillAnswerCounts };
}

export function savedAutofillHistory(
  store: Store,
  openingId: string,
): AutofillHistoryRecord[] {
  if (!store.opening(openingId)) throw new HttpError(404, "Opening not found");
  const rows = store.db
    .prepare(
      `SELECT id, json_extract(json, '$.version') AS version,
    json_extract(json, '$.createdAt') AS createdAt FROM records WHERE kind='application_autofill'
    AND json_extract(json, '$.openingId')=? ORDER BY rowid DESC`,
    )
    .all(openingId);
  return rows.map((row) => ({
    id: String(row.id),
    version: Number(row.version),
    createdAt: String(row.createdAt),
  }));
}
