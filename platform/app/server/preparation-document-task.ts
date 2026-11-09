import type { ApplicationPreparation } from "../shared/application-preparation.js";
import type { Task } from "../shared/task-records.js";
import { evidencePosting, readAutofillEvidence } from "./autofill/evidence.js";
import { documentOpeningHash } from "./preparation-documents.js";
import { MissingRecordError, type Store } from "./storage.js";
import type {
  TaskCreationBody,
  TaskCreationOptions,
} from "./task-kinds/registry.js";

export type PreparationTaskServices = {
  store: Store;
  createTask: (
    body: TaskCreationBody,
    options: TaskCreationOptions,
  ) => Promise<Task | undefined>;
};

export async function createPreparationDocumentTask(
  { store, createTask }: PreparationTaskServices,
  run: ApplicationPreparation,
  preset: string,
) {
  const opening = store.opening(run.openingId);
  if (!opening)
    throw new MissingRecordError(
      409,
      "opening",
      run.openingId,
      "Opening was removed during preparation",
    );
  const record = run.scriptId
    ? store.get("application_autofill", run.scriptId)
    : undefined;
  if (run.scriptId && (!record || record.openingId !== opening.id))
    throw new MissingRecordError(
      409,
      "application_autofill",
      run.scriptId,
      "The inspected application was removed or no longer matches this Opening",
    );
  const posting = record
    ? evidencePosting(record, readAutofillEvidence(store, record))
    : undefined;
  return createTask(
    {
      preset,
      mode: "handoff",
      prompt:
        "Generate my tailored application documents for this opening. Review the content against my evidence and writing guidelines.",
      context: {
        openingId: opening.id,
        companyId: opening.company_id,
        applicationId: run.applicationId,
      },
      postingUrl: opening.url,
      postingLabel: `${opening.company} ${opening.title}`.slice(0, 150),
      clientRequestId: `prepare:${run.id}:${preset}`,
    },
    {
      preparationContext: {
        id: run.id,
        openingHash: documentOpeningHash(opening),
        postingHash: run.postingHash,
        posting,
      },
    },
  );
}
