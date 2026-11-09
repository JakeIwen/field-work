import { createHash } from "node:crypto";
import type { Document } from "../shared/types.js";

export const applicationDocumentNamingVersion = 3;

export const cleanDocumentLabel = (label: string) =>
  label.replace(/\bjob[\s_-]+application[\s_-]+for[\s_:-]*/gi, "").trim();
export function documentFilename(
  label: string,
  kind: string,
  privacy: string,
  date: string,
  turnId: string,
  namingVersion = applicationDocumentNamingVersion,
) {
  const slug =
    cleanDocumentLabel(label)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70)
      .replace(/-$/, "") || "job-posting";
  const day = /^\d{4}-\d{2}-\d{2}/.test(date)
    ? date.slice(0, 10)
    : "date-unknown";
  const revision = createHash("sha256")
    .update(turnId)
    .digest("hex")
    .slice(0, 8);
  const variant =
    namingVersion >= 3 && privacy === "private" ? "" : `_${privacy}`;
  return `${day}_${slug}_${kind}${variant}_${revision}.pdf`;
}
export function normalizeGeneratedDocument(d: Document) {
  if (
    d.origin !== "generated" ||
    !d.createdAt ||
    !d.generatedTurnId ||
    !d.kind ||
    !d.privacy
  )
    return d;
  const label = cleanDocumentLabel(
    String(d.postingLabel || d.company || "job-posting"),
  );
  const namingVersion = d.namingVersion ?? 2;
  const name = documentFilename(
    label,
    d.kind,
    d.privacy,
    d.createdAt,
    d.generatedTurnId,
    namingVersion,
  );
  return {
    ...d,
    name,
    postingLabel: label,
    company: d.company ? cleanDocumentLabel(String(d.company)) : null,
    version: String(d.createdAt).slice(0, 10),
    originalVersion: d.originalVersion || d.version,
    originalName: d.originalName || d.name,
    namingVersion,
  };
}
