import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Store,
  HttpError,
  MissingRecordError,
  now,
  sha256,
} from "../storage.js";
import { savedAutofillScript } from "../greenhouse-autofill.js";
import {
  applicationDate,
  startOpeningApplication,
} from "../opening-workflow.js";

// Called only after clipboard success. This records the user's workflow shortcut,
// not evidence that the employer received an application.
export function recordAutofillCopy(
  store: Store,
  openingId: string,
  scriptId: string,
) {
  savedAutofillScript(store, openingId, scriptId);
  const opening = store.opening(openingId);
  if (!opening)
    throw new MissingRecordError(
      404,
      "opening",
      openingId,
      "Opening not found",
    );
  return store.transaction(() => {
    let application = store
      .list("application")
      .find((a) => a.openingId === openingId);
    if (!application?.submittedAt) {
      application ??= startOpeningApplication(store, openingId);
      const documents = (application.documentIds ?? []).map((id: string) => {
        const doc = store.document(id);
        if (!doc)
          throw new HttpError(
            409,
            "A selected document is missing. Review the application documents and retry.",
          );
        if (doc.status === "rejected")
          throw new HttpError(
            409,
            "A selected document was rejected. Review the application documents and retry.",
          );
        let bytes: Buffer;
        try {
          bytes = readFileSync(store.objectPath(doc.hash));
        } catch {
          throw new HttpError(
            409,
            "A selected document copy is missing. Restore it and retry.",
          );
        }
        if (sha256(bytes) !== doc.hash)
          throw new HttpError(
            409,
            "A selected document failed its integrity check. Restore it and retry.",
          );
        const { path, name, hash, privacy, format, version, kind } = doc;
        return { id, path, name, hash, privacy, format, version, kind };
      });
      const pack = {
        id: randomUUID(),
        at: now(),
        documents,
        source: "autofill-copy",
        scriptId,
      };
      application = store.put("application", application.id, {
        ...application,
        version: application.version + 1,
        updatedAt: pack.at,
        status: "applied",
        submittedAt: pack.at,
        submissionSource: "autofill-copy",
        packages: [...(application.packages ?? []), pack],
      });
      store.journal(
        "application_submitted",
        "Submission recorded when autofill script was copied",
        application.id,
        {
          packageId: pack.id,
          documentIds: application.documentIds,
          source: "autofill-copy",
          scriptId,
        },
      );
    }
    if (!application.followUp) {
      const submittedDate = applicationDate(
        store.get("settings", "main").timezone,
        new Date(application.submittedAt!),
      );
      const followUp = new Date(`${submittedDate}T00:00:00Z`);
      followUp.setUTCDate(followUp.getUTCDate() + 9);
      application = store.put("application", application.id, {
        ...application,
        version: application.version + 1,
        updatedAt: now(),
        followUp: followUp.toISOString().slice(0, 10),
      });
      store.journal(
        "application_updated",
        "Follow-up set nine days after submission",
        application.id,
        { followUp: application.followUp, source: "autofill-copy", scriptId },
      );
    }
    const personal = store.get("personal", openingId);
    if (personal?.reviewedHash !== opening.hash) {
      store.put("personal", openingId, {
        ...personal,
        id: openingId,
        version: (personal?.version ?? 0) + 1,
        updatedAt: now(),
        reviewedHash: opening.hash,
      });
    }
    return application;
  });
}
