import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { importRepository } from "../server/importer.js";
import { repositoryRoot as root, platformDocs } from "../server/paths.js";

const result = await importRepository(root);
if (!result.validSections.documents)
  throw new Error(
    "Document import was incomplete; existing catalog preserved.",
  );
const destination = path.join(platformDocs, "document-catalog.json");
let existing: any = null;
try {
  existing = JSON.parse(await readFile(destination, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const previous = new Map<string, any>(
  (existing?.documents ?? []).map((d: any) => [d.id, d]),
);
const generatedAt = new Date().toISOString();
const entries = result.documents.map(({ text, revisionNotes, ...doc }) => ({
  ...doc,
  firstCataloguedAt: previous.get(doc.id)?.firstCataloguedAt ?? generatedAt,
}));
// Retain previously catalogued content identities even when a path acquires new bytes.
for (const doc of existing?.documents ?? [])
  if (!entries.some((d) => d.id === doc.id))
    entries.push({
      ...doc,
      catalogStatus: "not present in latest file import",
    });
const catalog = {
  schemaVersion: 1,
  generatedAt,
  purpose:
    "Additive legacy-document metadata. File contents and declared masters remain authoritative. This is not application submission history.",
  identity:
    "logicalId = SHA-256(repository-relative path); id = logicalId + SHA-256(bytes). Immutable content IDs survive repository relocation.",
  datePolicy:
    "Explicit authorship/revision statements only. Unknown dates stay null; mtime is separate. firstCataloguedAt is not authorship.",
  documents: entries,
};
await mkdir(path.dirname(destination), { recursive: true });
const temporary = `${destination}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, {
  mode: 0o600,
});
await rename(temporary, destination);
console.log(
  `Catalogued ${result.documents.length} current files; ${entries.length} total content identities. ${path.relative(root, destination)}`,
);
