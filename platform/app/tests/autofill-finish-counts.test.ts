import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/storage.js";
import type { Records } from "../server/records.js";
import { openingAutofillCounts } from "../server/autofill/validity.js";
import type { ApplicationPreparation } from "../shared/application-preparation.js";

const review = (...labels: string[]) =>
  labels.map((label) => ({ label, required: true, reason: "Manual field" }));
const script = (id: string, openingId: string, value: object) =>
  ({
    id,
    openingId,
    dynamicQuestions: [],
    attachments: [{ id: "resume" }],
    ...value,
  }) as unknown as Records["application_autofill"];

test("finish counts use each Opening's latest complete script", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "autofill-finish-"));
  const store = new Store(root, path.join(root, ".local/data"));
  try {
    store.put(
      "application_autofill",
      "one-v1",
      script("one-v1", "one", { review: review("A", "B", "C") }),
    );
    store.put(
      "application_autofill",
      "one-v2",
      script("one-v2", "one", { review: review("Visa sponsorship") }),
    );
    // A script still drafting an answer or waiting on its files is not ready to copy.
    store.put(
      "application_autofill",
      "two-v1",
      script("two-v1", "two", {
        review: review("Why us?", "Start date"),
        dynamicQuestions: [{ label: "Why us?", key: "why" }],
      }),
    );
    store.put(
      "application_autofill",
      "three-v1",
      script("three-v1", "three", {
        review: review("Resume/CV", "Cover letter", "LinkedIn"),
        attachments: [],
      }),
    );
    // A script from before preparations existed has nothing pending.
    store.put(
      "application_autofill",
      "four-v1",
      script("four-v1", "four", {
        review: review("Resume/CV", "LinkedIn"),
        attachments: [],
      }),
    );
    const preparations = [
      { id: "run-three", openingId: "three", status: "failed" },
    ] as ApplicationPreparation[];
    assert.deepEqual(
      openingAutofillCounts(store, preparations).openingAutofillFinishCounts,
      {
        one: 1,
        four: 2,
      },
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
