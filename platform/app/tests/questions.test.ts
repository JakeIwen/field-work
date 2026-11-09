import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyDocument } from "./fixtures/legacy-records.js";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  publicAddress,
  postingUrl,
  fetchPosting,
  postingText,
} from "../server/job-posting.js";
import {
  referenceFromThread,
  questionReferenceId,
  prepareQuestionBundle,
  preparePostingDocumentBundle,
} from "../server/question-context.js";
import { unzipSync, strFromU8 } from "fflate";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import { importRepository } from "../server/importer.js";
import { contextTool } from "../server/context-tools.js";
import { draftPath } from "../server/bundles.js";
import { documentFilename } from "../server/application-documents.js";

test("posting URL boundaries block local, alternate-IP, credential and non-web destinations", () => {
  for (const value of [
    "http://localhost/jobs",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/",
    "http://10.0.0.1/",
    "file:///etc/passwd",
    "https://user:password@example.com",
    "https://example.com:8080/",
  ])
    assert.throws(() => postingUrl(value));
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  assert.equal(
    postingUrl("https://example.com/jobs/1#apply").href,
    "https://example.com/jobs/1",
  );
});
test("every redirect and all resolved addresses are vetted before a request is made", async () => {
  let reads = 0;
  await assert.rejects(
    fetchPosting("https://jobs.example.com/role", {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      read: async () => {
        reads++;
        return {
          status: 302,
          location: "http://169.254.169.254/latest",
          type: "text/html",
          body: Buffer.alloc(0),
        };
      },
    }),
    /Local, private/,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    fetchPosting("https://jobs.example.com/role", {
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      read: async () => {
        throw new Error("must not be requested");
      },
    }),
    /private or unsupported/,
  );
});
test("URL extraction pins a public address and retains salary/location source wording", async () => {
  const html =
    '<script type="application/ld+json">' +
    JSON.stringify({
      "@type": "JobPosting",
      title: "Senior Engineer",
      hiringOrganization: { name: "Example" },
      baseSalary: {
        currency: "USD",
        value: { minValue: 150000, maxValue: 190000 },
      },
      jobLocation: { name: "US remote" },
      description:
        "<p>React and TypeScript engineering with Node.js services and relational data. Work with a small team to maintain production integrations and reliable customer workflows.</p>",
    }) +
    '</script><script>throw "DO NOT EXECUTE"</script>';
  let pinned = "";
  const result = await fetchPosting("https://jobs.example.com/role", {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    read: async (_url, address) => {
      pinned = address.address;
      return { status: 200, type: "text/html", body: Buffer.from(html) };
    },
  });
  assert.equal(pinned, "8.8.8.8");
  assert.match(result.text, /190000/);
  assert.match(result.text, /US remote/);
  assert.doesNotMatch(result.text, /DO NOT EXECUTE/);
  assert.equal(result.kind, "url");
  assert.ok(result.fetchedAt.endsWith("Z"));
  assert.throws(
    () => postingText("<main>Access denied. Verify you are human.</main>"),
    /verification/,
  );
});
function reference() {
  return referenceFromThread({
    id: questionReferenceId,
    name: "job search questions",
    cwd: "/historical/workspace",
    updatedAt: 100,
    turns: [
      {
        items: [
          {
            type: "userMessage",
            content: [
              {
                type: "text",
                text: "Use restrained metrics and ordinary spaces.",
              },
            ],
          },
          {
            type: "agentMessage",
            text: "Ground application answers in the resume and evidence.",
          },
          { type: "reasoning", text: "HIDDEN_REASONING" },
          { type: "commandExecution", aggregatedOutput: "PRIVATE_TOOL_OUTPUT" },
        ],
      },
    ],
  });
}
test("reference import only reads the explicit session and keeps conversation data separate from hidden/tool content", () => {
  const r = reference();
  assert.equal(r.messages.length, 2);
  assert.doesNotMatch(r.text, /HIDDEN_REASONING|PRIVATE_TOOL_OUTPUT/);
  assert.throws(
    () => referenceFromThread({ id: "other", turns: [] }),
    /explicitly selected/,
  );
});
test("question and posting-document snapshots preserve original masters and include the correct posting", async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "fieldwork-question-test-"));
  const store = new Store(repositoryRoot, data);
  try {
    const imported = await importRepository(repositoryRoot);
    for (const doc of imported.documents)
      store.put("cache_document", doc.id, doc);
    const before = readFileSync(
      path.join(repositoryRoot, "source_data/resume.md"),
    );
    const task = {
      id: randomUUID(),
      preset: "questions",
      posting: {
        kind: "pasted",
        text: "CURRENT ROLE: React and Node.js",
        capturedAt: new Date().toISOString(),
        hash: "posting-hash",
      },
    };
    const q = prepareQuestionBundle(store, task, reference());
    assert.match(
      readFileSync(path.join(q.cwd, "job-posting.txt"), "utf8"),
      /CURRENT ROLE/,
    );
    assert.match(
      readFileSync(path.join(q.cwd, "reference-conversation.md"), "utf8"),
      /historical context/i,
    );
    const docTask = { ...task, id: randomUUID(), preset: "posting-resume" };
    const d = preparePostingDocumentBundle(store, docTask, reference());
    assert.equal(d.bundle.scope, "posting-draft");
    assert.equal(d.bundle.privateOnly, true);
    assert.ok(
      !d.bundle.paths.some((p: string) => /_public\.(html|pdf)$/.test(p)),
    );
    assert.match(
      readFileSync(path.join(d.cwd, "DOCUMENT-INSTRUCTIONS.md"), "utf8"),
      /Tailor/,
    );
    assert.deepEqual(
      readFileSync(path.join(repositoryRoot, "source_data/resume.md")),
      before,
    );
  } finally {
    store.close();
    rmSync(data, { recursive: true, force: true });
  }
});
test("generated PDF names are dated, distinguish variants and cannot escape their directory", () => {
  const name = documentFilename(
    "../Acme <Senior> / Engineer",
    "resume",
    "private",
    "2026-09-09T18:30:45.123Z",
    "turn-1",
  );
  assert.match(
    name,
    /^2026-09-09_Acme-Senior-Engineer_resume_[a-f0-9]{8}\.pdf$/,
  );
  assert.equal(path.basename(name), name);
  assert.ok(name.endsWith(".pdf"));
  assert.notEqual(
    name,
    documentFilename(
      "Acme Senior Engineer",
      "resume",
      "public",
      "2026-09-09T18:30:45.123Z",
      "turn-1",
    ),
  );
});

test("context broker blocks arbitrary reads, source writes, stale revisions and rendering overlap", () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "fieldwork-tool-test-"));
  const store = new Store(repositoryRoot, data);
  try {
    const task = {
      id: randomUUID(),
      threadId: "document-thread",
      preset: "posting-cover-letter",
      status: "running",
      posting: { kind: "pasted", text: "React engineering", hash: "test" },
    };
    const prepared = preparePostingDocumentBundle(store, task, reference());
    store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { ...task, manifest: prepared.manifest } as Records["task"],
    );
    const read = (path: string) =>
      contextTool(store, task.threadId, "read_job_search_source", { path });
    const write = (path: string, expectedHash: string, content: string) =>
      contextTool(store, task.threadId, "write_application_source", {
        path,
        expectedHash,
        content,
      });
    assert.throws(() => read("../../.codex/auth.json"), /not included/);
    assert.throws(() => read("/etc/passwd"), /not included/);
    const first = read("cover_letter.txt");
    assert.throws(
      () => write("AGENTS.md", read("AGENTS.md").hash, "overwrite"),
      /allowed draft/,
    );
    writeFileSync(
      draftPath(store, task.id, "cover_letter.txt"),
      "External edit",
    );
    assert.throws(
      () => write("cover_letter.txt", first.hash, "stale agent edit"),
      /changed|conflict|External edit/i,
    );
    assert.equal(read("cover_letter.txt").text, "External edit");
    write("cover_letter.txt", read("cover_letter.txt").hash, "Revised draft");
    assert.equal(read("cover_letter.txt").text, "Revised draft");
    store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...store.get("task", task.id),
        documentResult: { status: "rendering" },
      } as Records["task"],
    );
    assert.throws(
      () => write("cover_letter.txt", read("cover_letter.txt").hash, "overlap"),
      /cannot overlap/,
    );
    rmSync(draftPath(store, task.id, "cover_letter.txt"));
    symlinkSync("/etc/passwd", draftPath(store, task.id, "cover_letter.txt"));
    assert.throws(() => read("cover_letter.txt"), /symlinks/);
    store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...store.get("task", task.id),
        preset: "questions",
      } as Records["task"],
    );
    assert.throws(
      () => write("cover_letter.txt", first.hash, "x"),
      /cannot write/,
    );
  } finally {
    store.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("generated PDF revisions and frozen sources survive personal backup and repository reimport", async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "fieldwork-generated-test-"));
  const store = new Store(repositoryRoot, data);
  try {
    const source1 = Buffer.from("Original source");
    const source2 = Buffer.from("Revised source");
    const pdf1 = Buffer.from("PDF snapshot version one");
    const pdf2 = Buffer.from("PDF snapshot version two");
    for (const [index, pdf, source] of [
      [1, pdf1, source1],
      [2, pdf2, source2],
    ] as const) {
      const hash = sha256(pdf);
      const sourceHash = sha256(source);
      atomicWrite(store.objectPath(hash), pdf);
      atomicWrite(store.objectPath(sourceHash), source);
      store.put(
        "generated_document",
        `generated-${index}` /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        {
          id: `generated-${index}`,
          logicalId: "same-role-letter",
          hash,
          sourceHash,
          origin: "generated",
          format: "pdf",
          status: "draft",
          createdAt: `2026-09-09T18:00:0${index}Z`,
        } as Records["generated_document"],
      );
    }
    store.put("reference_context", questionReferenceId, reference());
    store.import(await importRepository(repositoryRoot));
    assert.equal(
      store.state().documents.filter((d) => d.origin === "generated").length,
      2,
    );
    const backup = unzipSync(store.backup());
    assert.deepEqual(Buffer.from(backup[`objects/${sha256(pdf1)}`]), pdf1);
    assert.deepEqual(
      Buffer.from(backup[`objects/${sha256(source1)}`]),
      source1,
    );
    assert.deepEqual(Buffer.from(backup[`objects/${sha256(pdf2)}`]), pdf2);
    const saved = JSON.parse(strFromU8(backup["personal-export.json"]));
    assert.equal(saved.records.generated_document.length, 2);
    assert.equal(saved.records.reference_context[0].id, questionReferenceId);
  } finally {
    store.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("application filenames omit time-of-day and generic job-application prefixes", () => {
  const name = documentFilename(
    "Job Application for Senior Engineer at Acme",
    "resume",
    "public",
    "2026-09-11T18:30:22.456Z",
    "turn-one",
  );
  assert.match(name, /^2026-09-11_Senior-Engineer-at-Acme_resume_public_/);
  assert.doesNotMatch(name, /Job-Application-for|T18|30-22/);
  assert.notEqual(
    name,
    documentFilename(
      "Job Application for Senior Engineer at Acme",
      "resume",
      "public",
      "2026-09-11T18:30:22.456Z",
      "turn-two",
    ),
  );
});

test("saved generated names migrate without changing PDF identities, bytes or original paths", () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "fieldwork-names-"));
  let store = new Store(repositoryRoot, data);
  try {
    const bytes = Buffer.from("immutable test PDF");
    const hash = sha256(bytes);
    atomicWrite(store.objectPath(hash), bytes);
    store.put(
      "generated_document",
      "saved",
      legacyDocument({
        id: "saved",
        origin: "generated",
        name: "2026-09-11T12-00-00Z_Job-Application-for-Engineer.pdf",
        path: ".local/original-export.pdf",
        postingLabel: "Job Application for Engineer at Acme",
        company: "Job Application for Engineer at Acme",
        version: "2026-09-11T12:00:00Z",
        kind: "resume",
        privacy: "public",
        createdAt: "2026-09-11T12:00:00Z",
        generatedTurnId: "turn",
        hash,
      }),
    );
    store.close();
    store = new Store(repositoryRoot, data);
    const d = store.document("saved")!;
    assert.match(d.name, /^2026-09-11_Engineer-at-Acme_resume_public_/);
    assert.equal(d.version, "2026-09-11");
    assert.equal(d.hash, hash);
    assert.equal(d.path, ".local/original-export.pdf");
    assert.deepEqual(readFileSync(store.objectPath(hash)), bytes);
    assert.match(d.originalName!, /T12-00/);
  } finally {
    store.close();
    rmSync(data, { recursive: true, force: true });
  }
});
