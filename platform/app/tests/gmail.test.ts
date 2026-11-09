import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { GmailManager, gmailScanVersion } from "../server/gmail/manager.js";
import {
  GmailError,
  parseGmailMessage,
  type GmailMessage,
  type GmailReader,
} from "../server/gmail/api.js";
import { matchEmployerReply } from "../server/gmail/matching.js";
import {
  finishGmailCheck as finished,
  gmailFixture as fixture,
  gmailTestAccount as account,
  gmailTestApplication as application,
  gmailTestAt as at,
  gmailTestMessage as message,
  gmailTestOpening as opening,
} from "./fixtures/gmail.js";

const match = (patch: Partial<GmailMessage> = {}, apps = [application()]) =>
  matchEmployerReply(message(patch), account, apps, [opening]);

const rejectionText =
  "Unfortunately, we will not be moving forward with your application for Senior Engineer at Acme Labs.";

test("failed negative scans retain pending decisions across restart and honor revoked automatic updates", async (t) => {
  let fail = true;
  const reader: GmailReader = {
    async list() {
      return { ids: ["abc123", "abc124"] };
    },
    async message(id) {
      if (id === "abc123") return message({ text: rejectionText });
      if (fail) throw new GmailError("Temporary message read failure");
      return null;
    },
  };
  const f = fixture(reader);
  try {
    f.manager.settings({
      enabled: true,
      autoUpdate: true,
      includeNegative: true,
    });
    f.manager.check();
    await finished(f.manager);
    assert.equal(f.manager.state().lastCheckedAt, undefined);
    assert.equal(f.manager.state().replies[0].pendingApplicationId, "app");
    assert.equal(f.store.get("application", "app")!.status, "applied");
    await f.manager.close();
    const recovered = new GmailManager(f.store, 4317, () => {}, reader);
    recovered.settings({
      enabled: true,
      autoUpdate: false,
      includeNegative: true,
    });
    fail = false;
    const later = Date.now() + 16 * 60000;
    t.mock.method(Date, "now", () => later);
    recovered.check();
    await finished(recovered);
    assert.ok(recovered.state().lastCheckedAt);
    assert.equal(recovered.state().replies.length, 1);
    assert.equal(recovered.state().replies[0].pendingApplicationId, undefined);
    assert.equal(f.store.get("application", "app")!.status, "applied");
    await recovered.close();
  } finally {
    await f.close();
  }
});

test("optional rejections update eligible applications and preserve evidence when hidden", async () => {
  for (const stage of [
    "applied",
    "interviewing",
    "offer",
    "withdrawn",
    "rejected",
  ] as const) {
    const f = fixture({
      async list() {
        return { ids: ["abc123"] };
      },
      async message() {
        return message({ text: rejectionText });
      },
    });
    try {
      const original = {
        ...application(),
        status: stage,
        nextAction: "My manual action",
      };
      f.store.put("application", "app", original);
      assert.equal(f.manager.preferences().includeNegative, false);
      f.manager.settings({
        enabled: true,
        autoUpdate: true,
        includeNegative: true,
      });
      f.manager.check();
      await finished(f.manager);
      const updated = f.store.get("application", "app")!;
      assert.equal(
        updated.status,
        stage === "applied" || stage === "interviewing" ? "rejected" : stage,
      );
      assert.equal(updated.notes, original.notes);
      assert.equal(updated.submittedAt, original.submittedAt);
      assert.equal(updated.followUp, original.followUp);
      assert.equal(updated.nextAction, original.nextAction);
      assert.deepEqual(updated.packages, original.packages);
      assert.equal(f.manager.state().replies[0].kind, "rejection");
      assert.equal(
        f.manager.state().replies[0].pendingApplicationId,
        undefined,
      );
      f.manager.settings({
        enabled: true,
        autoUpdate: true,
        includeNegative: false,
      });
      assert.equal(f.manager.state().replies.length, 0);
      assert.equal(
        f.store.list("employer_reply").length,
        1,
        "Hiding replies never deletes evidence",
      );
      assert.equal(f.store.get("application", "app")!.status, updated.status);
    } finally {
      await f.close();
    }
  }
});

test("negative review mode, newer manual edits and unclear hiring pauses do not reject applications", async () => {
  for (const scenario of ["review", "manual", "pause", "auth", "ambiguous"]) {
    const f = fixture({
      async list() {
        return { ids: ["abc123"] };
      },
      async message() {
        return message({
          text:
            scenario === "pause"
              ? "Hiring is paused for Senior Engineer at Acme Labs."
              : rejectionText,
          authenticated: scenario !== "auth",
        });
      },
    });
    try {
      f.manager.settings({
        enabled: true,
        autoUpdate: scenario !== "review",
        includeNegative: true,
      });
      if (scenario === "manual")
        f.store.put("application", "app", {
          ...application(),
          updatedAt: at(1),
        });
      if (scenario === "ambiguous")
        f.store.put("application", "second", {
          ...application(),
          id: "second",
        });
      f.manager.check();
      await finished(f.manager);
      assert.equal(f.store.get("application", "app")!.status, "applied");
      assert.equal(f.manager.state().replies.length, 1);
      assert.equal(f.manager.state().replies[0].update, undefined);
    } finally {
      await f.close();
    }
  }
});

test("enabling negative replies backfills 90 days, preserves old-client settings and invalidates the old scope cursor", async (t) => {
  const requests: { query: string; cursor?: string }[] = [];
  const f = fixture({
    async list(query, cursor) {
      requests.push({ query, cursor });
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    f.manager.check();
    await finished(f.manager);
    const previous = f.store.get("gmail_scan", account)!;
    f.store.put("gmail_scan", account, {
      ...previous,
      pending: {
        query: "old positive query",
        through: at(0),
        pageToken: "old-cursor",
        checked: 50,
      },
    });
    f.manager.settings({
      enabled: true,
      autoUpdate: true,
      includeNegative: true,
    });
    f.manager.settings({ enabled: false, autoUpdate: true });
    assert.equal(
      f.manager.preferences().includeNegative,
      true,
      "Old client payload preserves the new preference",
    );
    assert.equal(f.manager.state().needsNegativeBackfill, true);
    assert.equal(f.manager.state().hasMore, false);
    const later = Date.now() + 16 * 60000;
    t.mock.method(Date, "now", () => later);
    f.manager.check(true);
    await finished(f.manager);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].cursor, undefined);
    assert.ok(!requests[0].query.includes("interview"));
    assert.ok(!requests[1].query.includes("unfortunately"));
    assert.match(requests[1].query, /-in:sent -in:drafts -in:spam -in:trash$/);
    const since = Number(requests[1].query.match(/after:(\d+)/)![1]);
    assert.ok(since < Date.parse(previous.lastCheckedAt!) / 1000 - 89 * 86400);
    assert.equal(f.manager.state().needsNegativeBackfill, false);
    assert.equal(
      f.store.get("gmail_scan", account)!.lastIncludedNegative,
      true,
    );
    assert.throws(
      () =>
        f.manager.settings({
          enabled: true,
          autoUpdate: true,
          includeNegative: "yes",
        }),
      /Choose/,
    );
  } finally {
    await f.close();
  }
});

test("a rejection waits for terminal pagination and cannot override a newer invitation on a later page", async (t) => {
  const reject = message({ text: rejectionText, receivedAt: at(4) });
  const invite = message({ id: "abc124", receivedAt: at(3) });
  const f = fixture({
    async list(_query, cursor) {
      if (!cursor) return { ids: [reject.id], nextPageToken: "second" };
      if (cursor === "second") return { ids: [], nextPageToken: "third" };
      return { ids: [invite.id] };
    },
    async message(id) {
      return id === reject.id ? reject : invite;
    },
  });
  try {
    f.manager.settings({
      enabled: true,
      autoUpdate: true,
      includeNegative: true,
    });
    f.manager.check();
    assert.throws(
      () =>
        f.manager.settings({
          enabled: true,
          autoUpdate: true,
          includeNegative: false,
        }),
      /Wait for the current Gmail check/,
    );
    await finished(f.manager);
    assert.equal(f.manager.state().hasMore, true);
    assert.equal(f.store.get("application", "app")!.status, "applied");
    assert.equal(f.manager.state().replies[0].pendingApplicationId, "app");
    const later = Date.now() + 16 * 60000;
    t.mock.method(Date, "now", () => later);
    f.manager.check();
    await finished(f.manager);
    assert.equal(f.manager.state().hasMore, false);
    assert.equal(f.store.get("application", "app")!.status, "interviewing");
    const reply = f.manager
      .state()
      .replies.find((r) => r.kind === "rejection")!;
    assert.equal(reply.update, undefined);
    assert.equal(reply.pendingApplicationId, undefined);
    assert.match(reply.reason, /newer or simultaneous/);
  } finally {
    await f.close();
  }
});

test("a newer rejection settles after an older invitation regardless of result order, without duplicate updates", async (t) => {
  const reject = message({ text: rejectionText, receivedAt: at(3) });
  const invite = message({ id: "abc124", receivedAt: at(4) });
  const f = fixture({
    async list() {
      return { ids: [reject.id, invite.id] };
    },
    async message(id) {
      return id === reject.id ? reject : invite;
    },
  });
  try {
    f.manager.settings({
      enabled: true,
      autoUpdate: true,
      includeNegative: true,
    });
    f.manager.check();
    await finished(f.manager);
    assert.equal(f.store.get("application", "app")!.status, "rejected");
    assert.equal(f.store.get("application", "app")!.nextAction, "");
    const version = f.store.get("application", "app")!.version;
    const later = Date.now() + 16 * 60000;
    t.mock.method(Date, "now", () => later);
    f.manager.check();
    await finished(f.manager);
    assert.equal(f.store.get("application", "app")!.version, version);
    assert.equal(f.manager.state().replies.length, 2);
  } finally {
    await f.close();
  }
});

test("only explicit, authenticated, unique company and role matches qualify for automatic updates", () => {
  assert.equal(match()?.certainApplicationId, "app");
  assert.equal(
    match({ authenticated: false })?.certainApplicationId,
    undefined,
  );
  assert.equal(
    match({}, [application(), { ...application(), id: "app2" }])
      ?.certainApplicationId,
    undefined,
  );
  assert.equal(
    match({
      subject: "Acme Labs next steps",
      text: "Please share your availability for an interview.",
    })?.certainApplicationId,
    undefined,
  );
  assert.equal(
    match({
      subject: "Different company",
      sender: "Hiring <hiring@other.example>",
      text: "We invite you to an interview at Elsewhere.",
    }),
    null,
  );
  assert.equal(match({ sender: account }), null);
  assert.equal(
    match({
      text: "Please complete the coding assessment for Senior Engineer at Acme Labs.",
    })?.reply.kind,
    "assessment",
  );
  assert.equal(
    match({
      text: "We are pleased to offer you the Senior Engineer position at Acme Labs.",
    })?.reply.kind,
    "offer",
  );
});

test("receipts, conditional future invitations, rejection and quoted invitations do not qualify", () => {
  for (const text of [
    "Thank you for applying. Your application has been received. We may contact you to schedule an interview.",
    "If selected, we will invite you to an interview for Senior Engineer at Acme Labs.",
    "Unfortunately we are not moving forward after your interview for Senior Engineer at Acme Labs.",
    "Thanks for your time.\nOn Monday, Recruiter wrote:\nWe invite you to an interview for Senior Engineer at Acme Labs.",
  ])
    assert.equal(match({ text }), null, text);
});

test("Gmail MIME parsing ignores attachments, quoted HTML, sent mail and untrusted authentication headers", () => {
  const raw = {
    id: "abc123",
    threadId: "def123",
    internalDate: String(Date.now()),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Recruiter <hr@acme.example>" },
        { name: "Subject", value: "Next steps" },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; dkim=pass; dmarc=pass header.from=acme.example",
        },
      ],
      parts: [
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from(
              "<p>Please schedule your interview.</p><blockquote>Old offer</blockquote><script>bad()</script>",
            ).toString("base64url"),
          },
        },
        {
          mimeType: "text/plain",
          filename: "attachment.txt",
          body: { data: Buffer.from("Attached offer").toString("base64url") },
        },
      ],
    },
  };
  const parsed = parseGmailMessage(raw)!;
  assert.ok(parsed.text.includes("Please schedule"));
  assert.ok(!/Old offer|Attached offer|bad\(\)/.test(parsed.text));
  assert.equal(parsed.authenticated, true);
  assert.ok(
    parseGmailMessage({ ...raw, labelIds: undefined }),
    "Unlabelled archived mail remains eligible",
  );
  assert.equal(parseGmailMessage({ ...raw, labelIds: ["SENT"] }), null);
  assert.equal(
    parseGmailMessage({
      ...raw,
      payload: {
        ...raw.payload,
        headers: [
          {
            name: "Authentication-Results",
            value: "untrusted.example; dmarc=pass",
          },
          ...raw.payload.headers,
        ],
      },
    })?.authenticated,
    false,
  );
  assert.throws(() => parseGmailMessage({ ...raw, internalDate: "invalid" }));
});

test("load checks deduplicate, update only forward, preserve personal data and export evidence without credentials", async () => {
  let lists = 0;
  const f = fixture({
    async list() {
      lists++;
      return { ids: ["abc123", "abc124"] };
    },
    async message(id) {
      return message(
        id === "abc123"
          ? { receivedAt: at(4) }
          : {
              id,
              text: "We are pleased to offer you the Senior Engineer position at Acme Labs.",
              receivedAt: at(3),
            },
      );
    },
  });
  try {
    f.manager.check();
    f.manager.check();
    await finished(f.manager);
    assert.equal(lists, 1);
    const updated = f.store.get("application", "app")!;
    assert.equal(updated.status, "offer");
    assert.equal(updated.version, 3);
    assert.equal(updated.nextAction, "Review employer offer");
    assert.equal(updated.notes, "Keep these notes");
    assert.equal(updated.followUp, "2026-12-01");
    assert.deepEqual(updated.packages, []);
    assert.equal(f.manager.state().replies.length, 2);
    assert.ok(f.manager.state().lastCheckedAt);
    f.manager.review(f.manager.state().replies[0].id);
    assert.ok(f.manager.state().replies[0].reviewedAt);
    f.manager.check(true);
    assert.equal(lists, 1, "manual clicks respect cooldown");
    const files = unzipSync(f.store.backup());
    assert.ok(!Object.keys(files).some((key) => /gmail\/.*json/.test(key)));
    const exported = strFromU8(files["personal-export.json"]);
    assert.ok(exported.includes("employer_reply"));
    assert.ok(!exported.includes("private-refresh-token"));
    assert.ok(
      !JSON.stringify(f.manager.state()).includes("private-refresh-token"),
    );
  } finally {
    await f.close();
  }
});

test("review mode, newer manual edits, terminal stages and ambiguous matches leave application status intact", async () => {
  for (const scenario of [
    "review",
    "manual",
    "rejected",
    "ambiguous",
    "assessment",
  ]) {
    const f = fixture({
      async list() {
        return { ids: ["abc123"] };
      },
      async message() {
        return message(
          scenario === "assessment"
            ? {
                text: "Please complete the coding assessment for Senior Engineer at Acme Labs.",
              }
            : {},
        );
      },
    });
    try {
      if (scenario === "review")
        f.manager.settings({ enabled: true, autoUpdate: false });
      if (scenario === "manual")
        f.store.put("application", "app", {
          ...application(),
          updatedAt: at(1),
          version: 2,
        });
      if (scenario === "rejected")
        f.store.put("application", "app", {
          ...application(),
          status: "rejected",
        });
      if (scenario === "ambiguous")
        f.store.put("application", "app2", { ...application(), id: "app2" });
      f.manager.check();
      await finished(f.manager);
      assert.equal(
        f.store.get("application", "app")!.status,
        scenario === "rejected" ? "rejected" : "applied",
      );
      assert.equal(f.manager.state().replies.length, 1);
      if (scenario === "assessment")
        assert.match(
          f.store.get("application", "app")!.nextAction,
          /assessment/,
        );
      else assert.equal(f.manager.state().replies[0].update, undefined);
    } finally {
      await f.close();
    }
  }
});

test("failed pagination retains the exact page and successful-window timestamp, then resumes without duplicate updates", async (t) => {
  const cursors: (string | undefined)[] = [];
  let fail = true;
  const f = fixture({
    async list(_query, cursor) {
      cursors.push(cursor);
      if (!cursor) return { ids: ["abc123"], nextPageToken: "second" };
      if (fail) throw new GmailError("Rate limited", at(-0.01));
      return { ids: [] };
    },
    async message() {
      return message();
    },
  });
  try {
    f.manager.check();
    await finished(f.manager);
    assert.equal(f.manager.state().hasMore, true);
    assert.equal(f.manager.state().lastCheckedAt, undefined);
    assert.match(f.manager.state().error!, /Rate limited/);
    const query = f.store.get("gmail_scan", account)!.pending!.query;
    fail = false;
    const later = Date.now() + 86400000;
    t.mock.method(Date, "now", () => later);
    f.manager.check();
    await finished(f.manager);
    assert.deepEqual(cursors, [undefined, "second", "second"]);
    assert.equal(f.manager.state().hasMore, false);
    assert.equal(f.manager.state().replies.length, 1);
    assert.equal(f.store.get("application", "app")!.version, 2);
    assert.ok(query.includes("after:"));
    assert.ok(f.manager.state().lastCheckedAt);
  } finally {
    await f.close();
  }
});

test("automatic checks can be disabled and disconnect prevents further reads", async () => {
  let calls = 0;
  const f = fixture({
    async list() {
      calls++;
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    f.manager.settings({ enabled: false, autoUpdate: true });
    f.manager.check();
    assert.equal(calls, 0);
    f.manager.check(true);
    await finished(f.manager);
    assert.equal(calls, 1);
    f.manager.disconnect();
    f.manager.check(true);
    assert.equal(calls, 1);
    assert.equal(f.manager.state().connected, false);
    assert.equal(f.manager.state().nextCheckAt, undefined);
  } finally {
    await f.close();
  }
});
