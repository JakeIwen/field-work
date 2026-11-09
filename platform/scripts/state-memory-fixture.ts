import type { Store } from "../app/server/storage.js";
import {
  legacyTask,
  legacyOpening,
  legacyDocument,
  legacyCompany,
} from "../app/tests/fixtures/legacy-records.js";
import {
  card,
  posting,
  at,
} from "../app/tests/fixtures/greenhouse-pull-fixture.js";

const mib = 1024 * 1024;
const counts = {
  tasks: 400,
  openings: 400,
  documents: 400,
  companies: 200,
  journal: 400,
  candidates: 1000,
};

// Distinct prose-like records exercise parsing and compression, not repeated padding.
function text(bytes: number, seed: number) {
  const words = [
    "software",
    "engineer",
    "remote",
    "applications",
    "production",
    "maintain",
    "integrations",
    "evidence",
    "review",
    "systems",
    "database",
    "requirements",
    "company",
    "salary",
    "workflow",
    "testing",
  ];
  const parts: string[] = [];
  let size = 0;
  while (size < bytes) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const word = words[(seed >>> 16) % words.length] + " ";
    parts.push(word);
    size += word.length;
  }
  return parts.join("").slice(0, bytes);
}

export function seedStateMemory(store: Store, hiddenMiB: number) {
  store.transaction(() => {
    for (let i = 0; i < counts.tasks; i++)
      store.put(
        "task",
        `task-${i}`,
        legacyTask({
          id: `task-${i}`,
          status: "completed",
          messages: [
            {
              role: "assistant",
              text: text(Math.floor((6.46 * mib) / counts.tasks), i + 1),
            },
          ],
          events: [
            {
              method: "item/completed",
              params: {
                output: text(
                  Math.floor((hiddenMiB * mib) / counts.tasks),
                  i + 1000,
                ),
              },
            },
          ],
        }),
      );
    seedResearch(store);
    for (let i = 0; i < counts.journal; i++)
      store.put("journal", `journal-${i}`, {
        id: `journal-${i}`,
        at: new Date(at).toISOString(),
        type: "benchmark",
        message: text(160, i + 5000),
      });
    seedLedger(store);
  });
  return { ...counts, hiddenTaskMiB: hiddenMiB, postingKiB: 10 };
}

function seedResearch(store: Store) {
  for (let i = 0; i < counts.openings; i++)
    store.put(
      "cache_opening",
      `opening-${i}`,
      legacyOpening({
        id: `opening-${i}`,
        company_id: `company-${i % counts.companies}`,
        title: `Software engineer ${i}`,
        requirements: text(
          Math.floor((3.72 * mib) / counts.openings),
          i + 2000,
        ),
      }),
    );
  for (let i = 0; i < counts.documents; i++)
    store.put(
      "cache_document",
      `document-${i}`,
      legacyDocument({
        id: `document-${i}`,
        text: text(Math.floor((2.72 * mib) / counts.documents), i + 3000),
      }),
    );
  for (let i = 0; i < counts.companies; i++)
    store.put(
      "cache_company",
      `company-${i}`,
      legacyCompany({
        id: `company-${i}`,
        text: text(Math.floor((0.66 * mib) / counts.companies), i + 4000),
      }),
    );
}

function seedLedger(store: Store) {
  store.put("greenhouse_pull_run", "memory-ledger", {
    id: "memory-ledger",
    target: 10,
    clientRequestId: "benchmark",
    status: "exhausted",
    phase: "Synthetic history",
    queryIndex: 0,
    page: 1,
    cutoff: new Date(at).toISOString(),
    pages: [],
    failures: [],
    limitCount: 0,
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
  });
  for (let i = 0; i < counts.candidates; i++)
    store.put("greenhouse_pull_candidate", `memory-ledger:${i}`, {
      id: `memory-ledger:${i}`,
      runId: "memory-ledger",
      state: "excluded",
      card: card(String(i)),
      posting: {
        ...posting(card(String(i))),
        text: text(10 * 1024, i + 6000),
      },
    });
}
