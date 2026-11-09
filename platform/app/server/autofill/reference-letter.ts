import { tunable } from "../tunables.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ApplicationFileSlot,
  ApplicationSourceAttachment,
} from "../../shared/application-form.js";
import { referenceLetterSlot } from "../../shared/reference-letter-slot.js";
import { safeSource, sha256, type Store } from "../storage.js";
import { attachablePdf } from "../preparation-documents.js";
import { slotAcceptsPdf } from "./attachments.js";

import { referenceLetterPdfPath as referenceLetterPdf } from "../../shared/workspace-sources.js";

/** Optional applicant-supplied letter, stored with the workspace sources. */
export { referenceLetterPdf };

/** Upload slots the letter answers; an unreadable letter leaves them for manual review. */
export function referenceLetterAttachments(
  store: Store,
  fileSlots: ApplicationFileSlot[],
): ApplicationSourceAttachment[] {
  const slots = fileSlots.filter(
    (slot) =>
      slot.kind === "other" &&
      referenceLetterSlot(slot.label) &&
      slotAcceptsPdf(slot),
  );
  if (!slots.length) return [];
  let bytes: Buffer;
  try {
    bytes = readFileSync(safeSource(store.root, referenceLetterPdf));
  } catch {
    return [];
  }
  if (
    !attachablePdf(
      bytes,
      tunable(store, "autofill.attachmentLimitMiB") * 1024 * 1024,
    )
  )
    return [];
  const file = {
    sourcePath: referenceLetterPdf,
    name: path.basename(referenceLetterPdf),
    hash: sha256(bytes),
    mime: "application/pdf",
    size: bytes.length,
    base64: bytes.toString("base64"),
  };
  return slots.map((slot) => ({ ...slot, ...file }));
}
