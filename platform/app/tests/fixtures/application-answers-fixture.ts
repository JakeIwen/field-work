import type { Records } from "../../server/records.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, atomicWrite } from "../../server/storage.js";
import {
  answerKnowledgeHash,
  narrativeQuestion,
} from "../../server/application-answers.js";
import type { CareersFetch } from "../../server/careers/http.js";

export const url = "https://job-boards.greenhouse.io/example/jobs/123";
export const label =
  "Describe something you built with LLMs. What was the measurable effect?";
export const source = "source_data/github_evidence_dossier.md";
export function applicationAnswerFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "application-answers-"));
  const store = new Store(root, path.join(root, ".local/data"));
  const evidence = [
    "AGENTS.md",
    "source_data/README.md",
    "source_data/resume.md",
    source,
  ];
  for (const p of evidence)
    atomicWrite(
      path.join(root, p),
      "Synthetic test evidence. No production claims.",
    );
  atomicWrite(
    path.join(root, ".local/greenhouse/profile.json"),
    JSON.stringify({
      version: 1,
      firstName: "Test",
      email: "test@example.com",
    }),
  );
  store.put(
    "cache_opening",
    "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    { id: "one", url, hash: "opening" } as Records["cache_opening"],
  );
  const api = {
    id: 123,
    title: "Engineer",
    company_name: "Example",
    content: "Test job description",
    questions: [
      { label: "First Name", fields: [{ name: "first_name" }] },
      { label: "Email", fields: [{ name: "email" }] },
      {
        label,
        required: true,
        fields: [{ name: "question_123", type: "textarea" }],
      },
    ],
  };
  const html = `<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email"><label for="question_123">${label}</label><textarea id="question_123" maxlength="500"></textarea></form>`;
  const form = { html };
  const read: CareersFetch = async (u) => ({
    url: u,
    requestedUrl: u,
    status: 200,
    type: "text/html",
    text: u.includes("boards-api") ? JSON.stringify(api) : form.html,
    at: new Date().toISOString(),
  });
  const q = narrativeQuestion(
    {
      id: "question_123",
      label,
      kind: "textarea",
      required: true,
      maxLength: 500,
    },
    url,
  )!;
  const task = {
    id: "task",
    threadId: "thread",
    preset: "questions",
    status: "running",
    activeTurnId: "turn",
    context: { openingId: "one" },
    manifest: { paths: evidence, sourceHashes: {} },
    autofillContext: {
      url,
      questions: [q],
      knowledgeHash: answerKnowledgeHash(store),
    },
  };
  store.put(
    "task",
    task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    task as Records["task"],
  );
  const payload = {
    answers: [
      {
        fieldId: q.id,
        answer: "A supported draft whose impact needs clarification.",
        needsInput: false,
        sourcePaths: [source],
        caveats: ["No measured effect is documented."],
        manualReviewRequired: true,
        reviewReason: "Confirm the outcome before using this answer.",
      },
    ],
  };
  return {
    root,
    api,
    form,
    store,
    q,
    task,
    payload,
    read,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
