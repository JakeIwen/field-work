import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { draftPath } from "../server/bundles.js";
import {
  generationView,
  readFollowUp,
  restoreFollowUpDraft,
  saveFollowUpEdit,
  settleFollowUpTurn,
} from "../server/follow-up-email.js";
import {
  prepareFollowUpBundle,
  reviseFollowUpDraft,
  startFollowUpDraft,
} from "../server/follow-up-email-task.js";
import {
  recoverInterruptedSends,
  resolveUncertainSend,
  sendFollowUp,
  type FollowUpSendServices,
} from "../server/follow-up-email-send.js";
import { assertDeletionIdle } from "../server/record-deletion.js";
import { GmailError } from "../server/gmail/errors.js";
import {
  gmailSender,
  GmailSendUncertain,
  type GmailSender,
} from "../server/gmail/send.js";
import { dispatchTaskSourceTool } from "../server/task-kinds/registry.js";
import { purposeDynamicTools } from "../server/task-kinds/purpose-policies.js";
import { claudeSessionPolicy } from "../server/claude-code/tools.js";
import {
  modelRequestGroups,
  taskModelRequestType,
} from "../shared/codex-models.js";
import { atomicWrite, type Store } from "../server/storage.js";
import { encodingProbe, encodingSubject } from "./fixtures/email-encoding.js";
import {
  fakeSender,
  fakeTaskServices,
  followUpApplication,
  followUpBody,
  followUpCoverLetter,
  followUpFixture,
} from "./fixtures/follow-up-email.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

const save = (store: Store, taskId: string, args: Record<string, unknown>) =>
  dispatchTaskSourceTool(
    store,
    store.get("task", taskId)!,
    "save_follow_up_email",
    args,
  );
const draftArgs = {
  subject: "Following up on my Senior Engineer application",
  body: followUpBody,
  recipient: null,
};
const box = (body: string) => ({
  to: "dana@acme.example",
  subject: encodingSubject,
  body,
});

async function drafted(store: Store) {
  const fake = fakeTaskServices(store);
  startFollowUpDraft(fake.services, "app");
  await fake.idle();
  save(store, "task-1", draftArgs);
  fake.finishTurn("task-1");
  return { ...fake, record: readFollowUp(store, "app")! };
}

test("drafting starts one conversation, accepted once the agent starts it", async () => {
  const f = followUpFixture();
  try {
    const { services, calls, idle } = fakeTaskServices(f.store);
    const started = startFollowUpDraft(services, "app");
    assert.equal(started.generation?.status, "requested");
    assert.equal(
      startFollowUpDraft(services, "app").generation?.requestId,
      started.generation?.requestId,
      "a second click joins the first",
    );
    await idle();
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].preset, "follow-up-email");
    assert.equal(calls.created[0].mode, "handoff");
    assert.deepEqual(calls.created[0].context, {
      applicationId: "app",
      openingId: "opening",
      companyId: "acme",
    });
    assert.deepEqual(calls.started, ["task-1"]);
    const accepted = readFollowUp(f.store, "app")!.generation!;
    assert.deepEqual(
      [accepted.status, accepted.taskId],
      ["drafting", "task-1"],
    );
  } finally {
    f.close();
  }
});

test("the drafting snapshot holds the submitted cover letter, dates and Sam's known recipients", () => {
  const f = followUpFixture();
  try {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const bundle = prepareFollowUpBundle(f.store, {
      id,
      context: { applicationId: "app" },
      prompt: "Draft",
    });
    for (const file of [
      "AGENTS.md",
      "source_data/github_evidence_dossier.md",
      "job-posting.txt",
      "selected-opening.json",
      "cover-letter-sent.txt",
      "follow-up-context.json",
      "FOLLOW-UP-INSTRUCTIONS.md",
    ])
      assert.ok(bundle.manifest.paths.includes(file), file);
    assert.ok(
      readFileSync(
        draftPath(f.store, id, "cover-letter-sent.txt"),
        "utf8",
      ).includes(followUpCoverLetter),
    );
    const context = JSON.parse(
      readFileSync(draftPath(f.store, id, "follow-up-context.json"), "utf8"),
    );
    assert.deepEqual(context.knownRecipients, [
      { email: "dana@acme.example", source: "application contacts" },
    ]);
    assert.equal(context.application.submittedOn, "2026-10-04");
    assert.equal(
      context.application.submittedVia,
      "the employer's online application form",
    );
    assert.ok(existsSync(draftPath(f.store, id, "context-manifest.json")));
  } finally {
    f.close();
  }
});

test("the save tool validates the email and prefers Sam's own contact over a web suggestion", async () => {
  const f = followUpFixture();
  try {
    const { services, idle } = fakeTaskServices(f.store);
    startFollowUpDraft(services, "app");
    await idle();
    assert.throws(
      () => save(f.store, "task-1", { ...draftArgs, body: "Too short." }),
      /complete email/,
    );
    assert.throws(
      () =>
        save(f.store, "task-1", {
          ...draftArgs,
          recipient: {
            email: "no-reply@acme.example",
            sourceUrl: "https://acme.example/careers",
            basis: "footer",
          },
        }),
      /no-reply/,
    );
    assert.throws(
      () => save(f.store, "task-1", { ...draftArgs, subject: "Two\nlines" }),
      /one non-empty line/,
    );
    save(f.store, "task-1", {
      ...draftArgs,
      recipient: {
        email: "jobs@acme.example",
        sourceUrl: "https://acme.example/careers",
        basis: "Careers page contact",
      },
    });
    const record = readFollowUp(f.store, "app")!;
    assert.equal(record.draft?.to, "dana@acme.example");
    assert.equal(record.draft?.source, "generated");
    assert.equal(record.draft?.body, followUpBody);
    assert.equal(record.suggestion?.email, "jobs@acme.example");
    assert.equal(record.generation, undefined);
    assert.equal(record.draftTaskId, "task-1");
    assert.ok(
      f.store
        .list("journal")
        .some((e) => e.type === "follow_up_drafted" && e.entityId === "app"),
    );
  } finally {
    f.close();
  }
});

test("a conversation that is no longer the current request cannot overwrite the draft", async () => {
  const f = followUpFixture();
  try {
    const first = await drafted(f.store);
    f.store.put(
      "task",
      "stray",
      legacyTask({
        id: "stray",
        preset: "follow-up-email",
        status: "running",
        clientRequestId: "other",
        context: { applicationId: "app" },
      }),
    );
    startFollowUpDraft(first.services, "app");
    assert.throws(() => save(f.store, "stray", draftArgs), /no longer current/);
    await first.idle();
    f.store.put("task", "task-1", {
      ...f.store.get("task", "task-1")!,
      status: "running",
    });
    assert.throws(
      () => save(f.store, "task-1", draftArgs),
      /no longer current/,
    );
    assert.equal(
      readFollowUp(f.store, "app")!.draft?.id,
      first.record.draft?.id,
    );
  } finally {
    f.close();
  }
});

test("follow-up drafts are only for sent applications", () => {
  const f = followUpFixture();
  try {
    f.store.put("application", "app", {
      ...followUpApplication(),
      status: "ready",
      submittedAt: undefined,
      packages: [],
    });
    const { services } = fakeTaskServices(f.store);
    assert.throws(() => startFollowUpDraft(services, "app"), /already sent/);
  } finally {
    f.close();
  }
});

test("edits and restores keep every earlier draft and refuse stale writes", async () => {
  const f = followUpFixture();
  try {
    const { record } = await drafted(f.store);
    const edited = saveFollowUpEdit(
      f.store,
      "app",
      record.version,
      box(encodingProbe),
    );
    assert.equal(edited.draft?.source, "edited");
    assert.equal(
      edited.draft?.body,
      encodingProbe,
      "saved text is what was typed",
    );
    assert.equal(edited.history.length, 1);
    assert.equal(
      saveFollowUpEdit(f.store, "app", edited.version, box(encodingProbe))
        .version,
      edited.version,
      "an unchanged save is a no-op",
    );
    assert.throws(
      () => saveFollowUpEdit(f.store, "app", edited.version - 1, box("y")),
      /changed in another window/,
    );
    const first = edited.history.at(-1)!;
    const restored = restoreFollowUpDraft(
      f.store,
      "app",
      edited.version,
      first.id,
    );
    assert.equal(restored.draft?.source, "restored");
    assert.equal(restored.draft?.body, first.body);
    assert.equal(restored.history.length, 2);
    let latest = restored;
    for (let i = 0; i < 40; i++)
      latest = saveFollowUpEdit(
        f.store,
        "app",
        latest.version,
        box(`Body ${i}`),
      );
    assert.equal(latest.history.length, 30, "history is bounded");
  } finally {
    f.close();
  }
});

test("a revision saves the box first, stays locked until delivered, and cannot replace a newer draft", async () => {
  const f = followUpFixture();
  try {
    const fake = await drafted(f.store);
    const release = fake.hold();
    const unsaved = box(`${followUpBody}\nP.S. unsaved line`);
    reviseFollowUpDraft(fake.services, "app", {
      expectedVersion: fake.record.version,
      instruction: "Make it shorter",
      fields: unsaved,
    });
    const pending = readFollowUp(f.store, "app")!;
    assert.equal(
      pending.draft?.body,
      unsaved.body,
      "the box is saved before revising",
    );
    assert.equal(pending.generation?.status, "requested");
    assert.equal(
      generationView(f.store, pending.generation)?.status,
      "drafting",
    );
    assert.throws(
      () => saveFollowUpEdit(f.store, "app", pending.version, box("x")),
      /Wait for the current draft/,
      "edits stay locked while the revision is being delivered",
    );
    release();
    await fake.idle();
    assert.equal(fake.calls.messages[0].taskId, "task-1");
    assert.ok(fake.calls.messages[0].prompt.includes("P.S. unsaved line"));
    assert.ok(fake.calls.messages[0].prompt.includes("Make it shorter"));
    assert.equal(readFollowUp(f.store, "app")!.generation?.status, "drafting");

    save(f.store, "task-1", { ...draftArgs, body: `${followUpBody}\n` });
    const revised = readFollowUp(f.store, "app")!;
    assert.deepEqual(
      [
        revised.draft?.source,
        revised.draft?.instruction,
        revised.draft?.turnId,
        revised.draft?.to,
      ],
      ["revised", "Make it shorter", "turn-2", "dana@acme.example"],
    );

    fake.finishTurn("task-1");
    reviseFollowUpDraft(fake.services, "app", {
      expectedVersion: revised.version,
      instruction: "Warmer",
      fields: box(revised.draft!.body),
    });
    await fake.idle();
    // Another window replaced the draft before the model answered.
    const current = readFollowUp(f.store, "app")!;
    f.store.put("application_follow_up", "app", {
      ...current,
      draft: { ...current.draft!, id: "other-window" },
    });
    assert.throws(() => save(f.store, "task-1", draftArgs), /draft changed/);
    assert.equal(readFollowUp(f.store, "app")!.draft?.id, "other-window");
  } finally {
    f.close();
  }
});

test("a turn that ends without saving fails visibly, and unstarted or stopped requests never stay drafting", async () => {
  const f = followUpFixture();
  try {
    const fake = fakeTaskServices(f.store);
    startFollowUpDraft(fake.services, "app");
    await fake.idle();
    const task = f.store.get("task", "task-1")!;
    assert.equal(settleFollowUpTurn(f.store, task, true), true);
    const failed = readFollowUp(f.store, "app")!;
    assert.equal(failed.generation?.status, "failed");
    assert.match(failed.generation!.error!, /without saving a draft/);
    assert.equal(settleFollowUpTurn(f.store, task, true), false, "idempotent");

    startFollowUpDraft(fake.services, "app");
    await fake.idle();
    const drafting = readFollowUp(f.store, "app")!.generation!;
    assert.equal(generationView(f.store, drafting)?.status, "drafting");
    f.store.put("task", "task-2", {
      ...f.store.get("task", "task-2")!,
      status: "disconnected",
      error: "Application restarted.",
    });
    assert.deepEqual(
      [
        generationView(f.store, drafting)?.status,
        generationView(f.store, drafting)?.error,
      ],
      ["failed", "Application restarted."],
    );
    const abandoned = {
      ...drafting,
      status: "requested" as const,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    assert.equal(
      generationView(f.store, abandoned)?.status,
      "failed",
      "a restart before the agent accepted the request cannot leave it stuck",
    );
  } finally {
    f.close();
  }
});

function sendServices(
  store: Store,
  sender: GmailSender,
  sendGranted = true,
): FollowUpSendServices {
  return {
    store,
    sender,
    active: new Set(),
    changed: () => {},
    capability: () => ({
      connected: true,
      sendGranted,
      account: "candidate@example.net",
    }),
  };
}

/** Gmail's copy with its top headers or a decoded part changed. */
function rewriteCopy(
  raw: string,
  edit: {
    head?: (head: string) => string;
    plain?: (text: string) => string;
    html?: (html: string) => string;
  },
) {
  const end = raw.indexOf("\r\n\r\n");
  const head = edit.head ? edit.head(raw.slice(0, end)) : raw.slice(0, end);
  const body = raw
    .slice(end)
    .replace(
      /(Content-Type: text\/(plain|html); charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n)([A-Za-z0-9+/=\r\n]+?)(\r\n--)/g,
      (part, partHead: string, kind: string, data: string, delimiter) => {
        const change = kind === "plain" ? edit.plain : edit.html;
        if (!change) return part;
        const text = Buffer.from(data.replace(/\s+/g, ""), "base64");
        return `${partHead}${Buffer.from(change(text.toString("utf8")), "utf8").toString("base64")}${delimiter}`;
      },
    );
  return head + body;
}

test("an unnamed Gmail send-as address takes the saved profile's name", async () => {
  const f = followUpFixture();
  try {
    const { record } = await drafted(f.store);
    const sender: GmailSender & { sent: string[] } = {
      ...fakeSender(),
      identity: async () => ({ email: "candidate@example.net" }),
    };
    const testCopy = (expectedVersion: number) =>
      sendFollowUp(sendServices(f.store, sender), "app", {
        expectedVersion,
        draftId: record.draft!.id,
        testTo: "me@example.org",
      });
    const bare = await testCopy(record.version);
    assert.match(sender.sent[0], /^From: candidate@example\.net\r\n/);
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({ version: 1, firstName: "Sam", lastName: "Rivera" }),
    );
    await testCopy(bare.record.version);
    assert.match(
      sender.sent[1],
      /^From: "Sam Rivera" <candidate@example\.net>\r\n/,
    );
  } finally {
    f.close();
  }
});

test("sending checks Gmail's stored copy character for character and records only real sends", async () => {
  const f = followUpFixture();
  try {
    const { record } = await drafted(f.store);
    const edited = saveFollowUpEdit(
      f.store,
      "app",
      record.version,
      box(encodingProbe),
    );
    const request = {
      expectedVersion: edited.version,
      draftId: edited.draft!.id,
    };
    await assert.rejects(
      sendFollowUp(sendServices(f.store, fakeSender(), false), "app", request),
      /Authorize Gmail sending/,
    );

    const sender = fakeSender();
    const test = await sendFollowUp(sendServices(f.store, sender), "app", {
      ...request,
      testTo: "me@example.org",
    });
    assert.equal(test.sent.verification.status, "matched");
    assert.equal(test.record.testSends.length, 1);
    assert.equal(
      test.record.sent.length,
      0,
      "a test copy is not the follow-up",
    );
    assert.match(sender.sent[0], /\r\nTo: me@example\.org\r\n/);

    const real = await sendFollowUp(sendServices(f.store, sender), "app", {
      ...request,
      expectedVersion: test.record.version,
    });
    assert.equal(real.sent.verification.status, "matched");
    assert.equal(real.sent.delivery, "gmail");
    assert.equal(real.sent.body, encodingProbe);
    assert.equal(real.sent.to, "dana@acme.example");
    assert.equal(real.record.sending, undefined);
    assert.match(
      sender.sent[1],
      /^From: "Sam Rivera" <candidate@example\.net>\r\n/,
    );
    assert.ok(
      f.store
        .list("journal")
        .some((e) => e.type === "follow_up_sent" && e.entityId === "app"),
    );
    await assert.rejects(
      sendFollowUp(sendServices(f.store, sender), "app", request),
      /changed in another window/,
    );

    const testCopy = (transform: (raw: string) => string, version: number) =>
      sendFollowUp(sendServices(f.store, fakeSender(transform)), "app", {
        expectedVersion: version,
        draftId: edited.draft!.id,
        testTo: "me@example.org",
      });
    const mojibake = await testCopy(
      (raw) => rewriteCopy(raw, { plain: (text) => text.replace("é", "Ã©") }),
      real.record.version,
    );
    assert.equal(mojibake.sent.verification.status, "mismatch");
    assert.match(
      mojibake.sent.verification.detail!,
      /body differs at character \d+/i,
    );
    const lookalike = await testCopy(
      (raw) =>
        rewriteCopy(raw, {
          head: (head) => head.replace("To: me@", "To: some@"),
        }),
      mojibake.record.version,
    );
    assert.equal(
      lookalike.sent.verification.status,
      "mismatch",
      "a longer address containing the recipient is not a match",
    );
    const extra = await testCopy(
      (raw) =>
        rewriteCopy(raw, {
          head: (head) =>
            head.replace(
              "To: me@example.org",
              "To: me@example.org, x@example.org",
            ),
        }),
      lookalike.record.version,
    );
    assert.equal(
      extra.sent.verification.status,
      "mismatch",
      "an added recipient is not a match",
    );
    const html = await testCopy(
      (raw) =>
        rewriteCopy(raw, { html: (text) => text.replace("<br>", "<br><br>") }),
      extra.record.version,
    );
    assert.equal(html.sent.verification.status, "mismatch");
    assert.match(
      html.sent.verification.detail!,
      /^The formatted \(HTML\) version differs at character \d+/,
      "the plain text matched, so only the HTML part is reported",
    );
    const doubled = await testCopy((raw) => {
      const boundary = /boundary="([^"]+)"/.exec(raw)![1];
      const extra = [
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "",
        "<div>Different visible email</div>",
        `--${boundary}--`,
        "",
      ].join("\r\n");
      return raw.replace(`--${boundary}--\r\n`, extra);
    }, html.record.version);
    assert.equal(
      doubled.sent.verification.status,
      "mismatch",
      "an app would show the later HTML part, which was never checked",
    );
    assert.match(doubled.sent.verification.detail!, /1 plain-text and 2/);
  } finally {
    f.close();
  }
});

test("an unconfirmed send blocks retries until Sam records the outcome; a clear refusal leaves nothing pending", async () => {
  const f = followUpFixture();
  try {
    const { record } = await drafted(f.store);
    const request = {
      expectedVersion: record.version,
      draftId: record.draft!.id,
    };
    const rejected: GmailSender = {
      ...fakeSender(),
      send: async () => {
        throw new GmailError("Gmail rejected the message.");
      },
    };
    await assert.rejects(
      sendFollowUp(sendServices(f.store, rejected), "app", request),
      /rejected/,
    );
    let current = readFollowUp(f.store, "app")!;
    assert.deepEqual([current.sending, current.sent.length], [undefined, 0]);

    let inFlight = () => {};
    const lost: GmailSender = {
      ...fakeSender(),
      send: () =>
        new Promise((_, reject) => {
          inFlight = () =>
            reject(new GmailSendUncertain("Gmail did not answer."));
        }),
    };
    const attempt = sendFollowUp(sendServices(f.store, lost), "app", {
      ...request,
      expectedVersion: current.version,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => assertDeletionIdle(f.store),
      /Wait for active generation/,
      "deletion waits for a send in flight",
    );
    inFlight();
    await assert.rejects(attempt, /did not answer/);
    current = readFollowUp(f.store, "app")!;
    assert.equal(current.sending?.uncertain, true);
    await assert.rejects(
      sendFollowUp(sendServices(f.store, fakeSender()), "app", {
        ...request,
        expectedVersion: current.version,
      }),
      /Resolve the earlier send/,
    );
    assert.throws(
      () => saveFollowUpEdit(f.store, "app", current.version, box("y")),
      /Resolve the earlier send/,
    );

    const resolved = resolveUncertainSend(
      f.store,
      "app",
      current.version,
      "sent",
    );
    assert.equal(resolved.sending, undefined);
    assert.equal(resolved.sent.length, 1);
    assert.equal(resolved.sent[0].delivery, "reported");
    assert.equal(resolved.sent[0].verification.status, "unverified");
    assert.equal(resolved.sent[0].body, followUpBody);

    f.store.put("application_follow_up", "app", {
      ...resolved,
      sending: {
        id: "s",
        to: "dana@acme.example",
        draftId: resolved.draft!.id,
        test: false,
        startedAt: new Date().toISOString(),
      },
    });
    recoverInterruptedSends(f.store);
    const recovered = readFollowUp(f.store, "app")!;
    assert.equal(recovered.sending?.uncertain, true);
    const cleared = resolveUncertainSend(
      f.store,
      "app",
      recovered.version,
      "not-sent",
    );
    assert.deepEqual([cleared.sent.length, cleared.sending], [1, undefined]);
  } finally {
    f.close();
  }
});

test("a Gmail server error on send is uncertain, a client error is a refusal", async (t) => {
  let status = 500;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { status: "INTERNAL" } }, { status }),
  );
  const sender = gmailSender(async () => "token");
  await assert.rejects(sender.send("raw"), GmailSendUncertain);
  status = 400;
  await assert.rejects(
    sender.send("raw"),
    (error) => !(error instanceof GmailSendUncertain),
  );
});

test("follow-up drafting gets only its read and save tools plus web search, for Codex and Claude", () => {
  const names = (
    purposeDynamicTools("follow-up-email") as { name: string }[]
  ).map((tool) => tool.name);
  assert.deepEqual(names, ["read_job_search_source", "save_follow_up_email"]);
  const claude = claudeSessionPolicy("follow-up-email");
  assert.deepEqual(claude.tools, ["WebSearch"]);
  assert.deepEqual(claude.allowedTools, [
    "WebSearch",
    "mcp__fieldwork__read_job_search_source",
    "mcp__fieldwork__save_follow_up_email",
  ]);
  assert.equal(
    taskModelRequestType({ preset: "follow-up-email" }),
    "follow-up-email",
  );
  assert.ok(
    modelRequestGroups.some((group) =>
      group.requests.includes("follow-up-email"),
    ),
  );
});

test("follow-up routes preserve typed Unicode exactly over HTTP and require Gmail send permission", async () => {
  const f = followUpFixture();
  f.closeStore();
  const w = await openFixtureWorkspace(f.root);
  try {
    w.store.put("application", "app", followUpApplication());
    const base = "/api/applications/app/follow-up";
    let view = await (await w.get(base)).json();
    assert.deepEqual(view.capability, { connected: false, sendGranted: false });
    assert.equal(view.followUp.draft, undefined);
    assert.equal(
      (
        await w.post(
          base,
          { expectedVersion: 0, to: "", subject: "x", body: "y" },
          "PUT",
        )
      ).status,
      409,
    );
    w.store.put("application_follow_up", "app", {
      id: "app",
      applicationId: "app",
      openingId: "opening",
      version: 1,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
      history: [],
      sent: [],
      testSends: [],
      draft: {
        id: "d1",
        to: "",
        subject: "Hello",
        body: followUpBody,
        source: "generated",
        at: "2026-10-15T00:00:00Z",
      },
    });
    const put = await w.post(
      base,
      {
        expectedVersion: 1,
        to: "dana@acme.example",
        subject: encodingSubject,
        body: encodingProbe.replace(/\n/g, "\r\n"),
      },
      "PUT",
    );
    assert.equal(put.status, 200);
    view = await (await w.get(base)).json();
    assert.equal(
      view.followUp.draft.body,
      encodingProbe,
      "CRLF from a form becomes LF; every character is kept",
    );
    assert.equal(view.followUp.draft.subject, encodingSubject);
    assert.equal(view.history.length, 1);
    const state = await (await w.get("/api/state")).json();
    assert.equal(state.followUps[0].draft.body, encodingProbe);
    assert.equal(
      state.followUps[0].history,
      undefined,
      "history stays out of the global state",
    );

    const send = await w.post(`${base}/send`, {
      expectedVersion: view.followUp.version,
      draftId: view.followUp.draft.id,
    });
    assert.equal(send.status, 409);
    assert.match((await send.json()).error, /Authorize Gmail sending/);
    assert.equal(
      (
        await w.post(
          base,
          {
            expectedVersion: view.followUp.version,
            to: "Dana <dana@acme.example>",
            subject: "x",
            body: "y",
          },
          "PUT",
        )
      ).status,
      400,
    );
  } finally {
    await w.close();
    f.close();
  }
});

test("follow-up request grace reads the current override", () => {
  const f = followUpFixture();
  try {
    const generation = {
      kind: "generate" as const,
      requestId: "override",
      status: "requested" as const,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    assert.equal(generationView(f.store, generation)?.status, "drafting");
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "followUp.graceMin": 1 },
    });
    assert.equal(generationView(f.store, generation)?.status, "failed");
  } finally {
    f.close();
  }
});
