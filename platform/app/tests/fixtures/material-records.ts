import { readFileSync } from "node:fs";
import { Store, now } from "../../server/storage.js";
import {
  fixtureEvidenceHashes,
  saveFixturePdf,
  saveCompletedDocumentTask,
} from "./document-records.js";
import { currentDocumentWritingRules } from "../../server/document-writing-status.js";
import { documentPostingHash } from "../../server/preparation-documents.js";
import { applicationAnswerFixture } from "./application-answers-fixture.js";
import { legacyTask, legacyOpening } from "./legacy-records.js";

export function materialAnswerFixture() {
  const f = applicationAnswerFixture();
  f.form.html = f.form.html.replace(
    "</form>",
    '<div class="file-upload"><div id="upload-label-resume">Resume/CV*</div><label for="resume">Attach</label><input id="resume" type="file"></div><div class="file-upload"><div id="upload-label-cover_letter">Cover Letter</div><label for="cover_letter">Attach</label><input id="cover_letter" type="file"></div></form>',
  );
  return f;
}

/** Synthetic PDF objects exercise persistence, not the native PDF renderer. */
export function saveMaterialPdfs(
  store: Store,
  revision = "original",
  posting?: unknown,
) {
  store.put(
    "cache_opening",
    "one",
    legacyOpening({
      company_id: "company",
      company: "Example",
      title: "Engineer",
      ...store.opening("one"),
    }),
  );
  const taskId = `documents-${revision}`;
  const task = legacyTask({ id: taskId, preset: "posting-application" });
  const ids = ["resume", "cover-letter"].map(
    (kind) =>
      saveFixturePdf(
        store,
        {
          id: `${taskId}-${kind}`,
          openingId: "one",
          kind,
          status: "draft",
          generatedBy: taskId,
          createdAt: now(),
        },
        Buffer.from(`%PDF-1.4\nSynthetic ${kind} ${revision}`),
        `Synthetic ${kind} source ${revision}`,
      ).id,
  );
  saveCompletedDocumentTask(
    store,
    task,
    "one",
    ids,
    {
      writingRuleHashes: currentDocumentWritingRules(store, task),
      sourceHashes: fixtureEvidenceHashes(store),
    },
    posting ? documentPostingHash(posting) : undefined,
  );
  return ids;
}

export function materialBytes(store: Store, ids: string[]) {
  return ids.map((id) => {
    const document = store.document(id);
    if (!document) throw new Error(`Missing fixture document ${id}`);
    return {
      id,
      hash: document.hash,
      bytes: readFileSync(store.objectPath(document.hash)),
    };
  });
}
