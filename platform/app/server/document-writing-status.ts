import { cachedRead } from "./storage-read-cache.js";
import { readFileSync } from "node:fs";
import type { Document, TaskSummary } from "../shared/types.js";
import type { Task, Bundle } from "../shared/task-records.js";
import { applicationDocumentKinds } from "../shared/application-preparation.js";
import { type Store, safeSource } from "./storage.js";
import { draftPath } from "./bundles.js";
import {
  postingInstructionParts,
  type DocumentInstructionParts,
} from "./document-instructions.js";
import {
  legacyInstructionParts,
  writingRuleHashes,
} from "./document-writing-rules.js";

type WritingTask = Pick<Task, "id" | "preset" | "bundle">;

export function currentDocumentWritingRules(
  store: Store,
  task: WritingTask,
  agents?: string,
) {
  return cachedWritingRuleHashes(
    store,
    agents ??
      cachedRead(store, "documentWritingAgents", () =>
        readFileSync(safeSource(store.root, "AGENTS.md"), "utf8"),
      ),
    postingInstructionParts(task.preset, task.bundle ?? {}),
  );
}

export function capturedDocumentWritingRules(
  store: Store,
  task: WritingTask,
  bundle?: Bundle,
) {
  if (bundle?.writingRuleHashes || task.bundle?.writingRuleHashes)
    return bundle?.writingRuleHashes ?? task.bundle?.writingRuleHashes;
  return cachedRead(
    store,
    JSON.stringify(["capturedDocumentWritingRules", task.id]),
    () => {
      try {
        const instructions = readFileSync(
          draftPath(store, task.id, "DOCUMENT-INSTRUCTIONS.md"),
          "utf8",
        );
        const parts = legacyInstructionParts(instructions);
        if (!parts) return;
        return cachedWritingRuleHashes(
          store,
          readFileSync(draftPath(store, task.id, "AGENTS.md"), "utf8"),
          parts,
        );
      } catch {
        /* Missing historical instructions cannot establish current writing policy. */
      }
    },
  );
}

function cachedWritingRuleHashes(
  store: Store,
  agents: string,
  parts: DocumentInstructionParts,
) {
  // Key whole source texts once rather than serializing AGENTS.md per document.
  const byAgents = cachedRead(
    store,
    "documentWritingRuleHashes",
    () => new Map<string, Map<string, ReturnType<typeof writingRuleHashes>>>(),
  );
  let byParts = byAgents.get(agents);
  if (!byParts) {
    byParts = new Map();
    byAgents.set(agents, byParts);
  }
  const key = JSON.stringify(parts);
  let hashes = byParts.get(key);
  if (!hashes) {
    hashes = writingRuleHashes(agents, parts);
    byParts.set(key, hashes);
  }
  return hashes;
}

export function documentWritingWarning(
  store: Store,
  doc: Document,
  task?: WritingTask,
  agents?: string,
) {
  return cachedRead(
    store,
    JSON.stringify([
      "documentWritingWarning",
      doc.id,
      doc.writingRuleHash,
      doc.generatedBy,
      task?.id,
    ]),
    () => readDocumentWritingWarning(store, doc, task, agents),
  );
}
function readDocumentWritingWarning(
  store: Store,
  doc: Document,
  task?: WritingTask,
  agents?: string,
) {
  const kind = applicationDocumentKinds.find((kind) => kind === doc.kind);
  if ((!doc.generatedBy && doc.origin !== "generated") || !kind) return;
  task ??= doc.generatedBy
    ? store.taskSummaries(doc.generatedBy)[0]
    : undefined;
  const label = kind === "resume" ? "Resume" : "Cover letter";
  const captured =
    doc.writingRuleHash ??
    (task && capturedDocumentWritingRules(store, task)?.[kind]);
  if (!task || !captured)
    return `${label} writing instructions could not be verified. Generate a new ${kind === "resume" ? "resume" : "cover letter"}.`;
  try {
    if (captured !== currentDocumentWritingRules(store, task, agents)[kind])
      return `${label} writing rules changed. Generate a new ${kind === "resume" ? "resume" : "cover letter"}.`;
  } catch {
    return `${label} writing rules could not be checked. Check the current writing instructions.`;
  }
}

export function documentsWithWritingWarnings(
  store: Store,
  documents: Document[],
  tasks: TaskSummary[],
) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let agents: string | undefined;
  try {
    agents = readFileSync(safeSource(store.root, "AGENTS.md"), "utf8");
  } catch {
    /* Each affected document gets a readable warning. */
  }
  return documents.map((doc) => ({
    ...doc,
    writingRuleWarning: documentWritingWarning(
      store,
      doc,
      byId.get(doc.generatedBy ?? ""),
      agents,
    ),
  }));
}
