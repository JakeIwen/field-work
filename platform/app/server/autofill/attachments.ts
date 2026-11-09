import type {
  ApplicationDocumentAttachment,
  ApplicationExecutionAttachment,
  ApplicationFileSlot,
  ApplicationSourceAttachment,
} from "../../shared/application-form.js";
import type { AutofillRecord } from "../../shared/greenhouse-autofill.js";
import { HttpError, type Store } from "../storage.js";
import { preparationDocument } from "../preparation-documents.js";

export const slotAcceptsPdf = (slot: ApplicationFileSlot) =>
  !slot.accept?.length ||
  slot.accept.some((accept) =>
    [".pdf", "application/pdf", "application/*", "*/*"].includes(
      accept.toLowerCase(),
    ),
  );

export function packageApplicationAttachments(
  store: Store,
  openingId: string,
  documentIds: string[],
  postingHash: string,
  fileSlots: ApplicationFileSlot[],
) {
  const attachments: ApplicationDocumentAttachment[] = [];
  const review: AutofillRecord["review"] = [];
  const seen = new Set<string>();
  for (const id of documentIds) {
    const { doc, bytes } = preparationDocument(
      store,
      openingId,
      id,
      postingHash,
    );
    if (seen.has(doc.kind))
      throw new HttpError(409, "Choose only one resume and one cover letter.");
    seen.add(doc.kind);
    const matches = fileSlots.filter((slot) => slot.kind === doc.kind);
    if (matches.length !== 1) {
      if (doc.kind === "resume")
        throw new HttpError(
          422,
          "This form does not expose a supported resume upload control. Your PDFs remain available to download.",
        );
      review.push({
        label: "Cover letter",
        required: false,
        reason:
          "This application has no unambiguous cover-letter upload slot. Your cover letter remains available to download.",
      });
      continue;
    }
    const slot = matches[0];
    if (!slotAcceptsPdf(slot)) {
      if (doc.kind === "cover-letter") {
        review.push({
          label: slot.label,
          required: slot.required,
          reason:
            "This cover-letter slot does not accept PDF files. Your cover letter remains available to download.",
        });
        continue;
      }
      throw new HttpError(
        422,
        `The ${slot.label} field does not accept PDF files. Your PDFs remain available to download.`,
      );
    }
    attachments.push({
      ...slot,
      documentId: doc.id,
      name: doc.name,
      hash: doc.hash,
      mime: "application/pdf",
      size: bytes.length,
      base64: bytes.toString("base64"),
    });
  }
  return { attachments, review };
}

export function reviewWithoutAttached(
  review: AutofillRecord["review"],
  attachments: ApplicationExecutionAttachment[],
  attachmentLabelAlias?: (attachment: ApplicationExecutionAttachment) => string,
): AutofillRecord["review"] {
  return review.filter(
    (item) =>
      !attachments.some(
        (attachment) =>
          item.label === attachment.label ||
          item.label === attachmentLabelAlias?.(attachment),
      ),
  );
}

export function savedAttachment(
  attachment: ApplicationDocumentAttachment,
  legacyGreenhouse = false,
): NonNullable<AutofillRecord["attachments"]>[number] {
  const {
    documentId,
    name,
    hash,
    mime,
    size,
    base64: _bytes,
    ...slot
  } = attachment;
  return {
    id: slot.stableId,
    label: slot.label,
    documentId,
    name,
    hash,
    mime,
    size,
    ...(legacyGreenhouse ? {} : { slot }),
  };
}

export function savedSourceAttachment(
  attachment: ApplicationSourceAttachment,
): NonNullable<AutofillRecord["sourceAttachments"]>[number] {
  const {
    sourcePath,
    name,
    hash,
    mime,
    size,
    base64: _bytes,
    ...slot
  } = attachment;
  return {
    id: slot.stableId,
    label: slot.label,
    sourcePath,
    name,
    hash,
    mime,
    size,
    slot,
  };
}

export function legacyGreenhouseAttachment(
  attachment: ApplicationExecutionAttachment,
) {
  if ("documentId" in attachment)
    return { ...savedAttachment(attachment, true), base64: attachment.base64 };
  const { slot: _slot, ...saved } = savedSourceAttachment(attachment);
  return { ...saved, base64: attachment.base64 };
}
