import test from "node:test";
import assert from "node:assert/strict";
import {
  gmailCheckIntervalMs,
  gmailConnectingDelayMs,
  gmailContinuationDelayMs,
  gmailScanVersion,
} from "../server/gmail/manager.js";
import { matchGmailMessage } from "../server/gmail/scan.js";
import {
  GmailError,
  GmailReconnectError,
  type GmailMessage,
  type GmailReader,
} from "../server/gmail/api.js";
import {
  finishGmailCheck,
  gmailFixture,
  gmailTestAccount as account,
  gmailTestApplication as application,
  gmailTestAt as at,
  gmailTestMessage as message,
  gmailTestOpening as opening,
} from "./fixtures/gmail.js";

test("a scanner upgrade preserves the timestamp and starts a broad 90-day rescan", async (t) => {
  const requests: string[] = [];
  const f = gmailFixture({
    async list(query) {
      requests.push(query);
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    const completedAt = at(20);
    f.store.put("gmail_scan", account, {
      account,
      lastCheckedAt: completedAt,
      lastAttemptAt: at(1),
      lastScanVersion: gmailScanVersion - 1,
    });
    assert.equal(f.manager.state().needsRescan, true);
    assert.equal(f.manager.state().lastCheckedAt, completedAt);
    const currentTime = Date.now();
    t.mock.method(Date, "now", () => currentTime);
    f.manager.check(true);
    await finishGmailCheck(f.manager);
    const since = Number(requests[0].match(/after:(\d+)/)![1]);
    assert.ok(since <= Date.now() / 1000 - 89 * 86_400);
    assert.equal(f.manager.state().needsRescan, false);
    assert.equal(
      f.store.get("gmail_scan", account)!.lastScanVersion,
      gmailScanVersion,
    );
  } finally {
    await f.close();
  }
});

test("background scanning is explicit and automatically continues bounded passes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cursors: (string | undefined)[] = [];
  const f = gmailFixture({
    async list(_query, cursor) {
      cursors.push(cursor);
      if (!cursor) return { ids: [], nextPageToken: "second" };
      if (cursor === "second") return { ids: [], nextPageToken: "third" };
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    await Promise.resolve();
    assert.deepEqual(cursors, [], "constructing a manager starts no timer");
    f.manager.startBackground();
    t.mock.timers.tick(0);
    await finishGmailCheck(f.manager);
    assert.deepEqual(cursors, [undefined, "second"]);
    t.mock.timers.tick(gmailContinuationDelayMs);
    await finishGmailCheck(f.manager);
    assert.deepEqual(cursors, [undefined, "second", "third"]);
  } finally {
    await f.close();
  }
});

test("a partial manual check replaces the old background due time with prompt continuation", async (t) => {
  const currentTime = Date.now();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: currentTime });
  const cursors: (string | undefined)[] = [];
  const f = gmailFixture({
    async list(_query, cursor) {
      cursors.push(cursor);
      if (!cursor) return { ids: [], nextPageToken: "second" };
      if (cursor === "second") return { ids: [], nextPageToken: "third" };
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    f.store.put("gmail_scan", account, {
      account,
      lastAttemptAt: new Date(currentTime - 120_000).toISOString(),
    });
    f.manager.startBackground();
    t.mock.timers.tick(0);
    assert.deepEqual(cursors, []);
    f.manager.check(true);
    await finishGmailCheck(f.manager);
    assert.deepEqual(cursors, [undefined, "second"]);
    assert.equal(
      f.manager.state().nextCheckAt,
      new Date(currentTime + gmailContinuationDelayMs).toISOString(),
    );
    t.mock.timers.tick(gmailContinuationDelayMs);
    await finishGmailCheck(f.manager);
    assert.deepEqual(cursors, [undefined, "second", "third"]);
    t.mock.timers.tick(13 * 60_000);
    assert.equal(cursors.length, 3, "the replaced timer cannot fire later");
  } finally {
    await f.close();
  }
});

test("every plausible thread is checked and future messages never supply context", async () => {
  let threadCalls = 0;
  const reader: GmailReader = {
    async list() {
      return { ids: [] };
    },
    async message() {
      return null;
    },
    async thread(id) {
      threadCalls++;
      return [receipt(id, id === "future" ? at(2) : at(4))];
    },
  };
  const threadCache = new Map<string, Promise<GmailMessage[]>>();
  for (let index = 0; index < 11; index++) {
    const result = await contextMatch(`thread-${index}`, reader, threadCache);
    assert.deepEqual(result?.reply.applicationIds, ["app"]);
  }
  const future = await contextMatch("future", reader, threadCache);
  assert.ok(!future || future.reply.applicationIds.length === 0);
  assert.equal(threadCalls, 12);
});

const receipt = (threadId: string, receivedAt: string) =>
  message({
    id: `${threadId}-receipt`,
    threadId,
    sender: "no-reply@ats.example",
    subject: "Acme Labs — Senior Engineer",
    text: "Thank you for applying. Your application was received.",
    receivedAt,
  });

const contextMatch = (
  threadId: string,
  reader: GmailReader,
  threadCache: Map<string, Promise<GmailMessage[]>>,
) =>
  matchGmailMessage({
    message: message({
      id: `${threadId}-current`,
      threadId,
      sender: "Recruiter <person@agency.example>",
      subject: "Re: application",
      text: "I sent the calendar invite.",
      receivedAt: at(3),
    }),
    account,
    includeNegative: false,
    applications: [application()],
    openings: [opening],
    reader,
    threadCache,
  });

test("startup honors the existing cooldown and reports its exact next check", async (t) => {
  const currentTime = Date.now();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: currentTime });
  let calls = 0;
  const f = gmailFixture(countingReader(() => calls++));
  try {
    const lastAttemptAt = new Date(currentTime - 60_000).toISOString();
    f.store.put("gmail_scan", account, { account, lastAttemptAt });
    f.manager.startBackground();
    t.mock.timers.tick(0);
    assert.equal(calls, 0);
    assert.equal(
      f.manager.state().nextCheckAt,
      new Date(Date.parse(lastAttemptAt) + gmailCheckIntervalMs).toISOString(),
    );
    t.mock.timers.tick(gmailCheckIntervalMs - 60_001);
    assert.equal(calls, 0);
    t.mock.timers.tick(1);
    await finishGmailCheck(f.manager);
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("an overdue cursor waits while OAuth is connecting instead of spinning", async (t) => {
  const currentTime = Date.now();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: currentTime });
  let calls = 0;
  const f = gmailFixture(countingReader(() => calls++));
  try {
    f.store.put("gmail_scan", account, overdueScan(currentTime));
    f.manager.auth.connecting = true;
    f.manager.startBackground();
    t.mock.timers.tick(0);
    t.mock.timers.tick(gmailConnectingDelayMs - 1);
    assert.equal(calls, 0);
    f.manager.auth.connecting = false;
    t.mock.timers.tick(1);
    await finishGmailCheck(f.manager);
    assert.equal(calls, 1);
  } finally {
    f.manager.auth.connecting = false;
    await f.close();
  }
});

const countingReader = (called: () => void): GmailReader => ({
  async list() {
    called();
    return { ids: [] };
  },
  async message() {
    return null;
  },
});

const overdueScan = (currentTime: number) => ({
  account,
  lastAttemptAt: new Date(currentTime - 60_000).toISOString(),
  pending: {
    query: "existing broad query",
    through: new Date(currentTime).toISOString(),
    pageToken: "next",
    checked: 50,
    scanVersion: gmailScanVersion,
  },
});

test("disabling Gmail during a pass prevents its saved cursor from continuing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveList!: (value: { ids: string[]; nextPageToken: string }) => void;
  let calls = 0;
  const f = gmailFixture({
    async list() {
      calls++;
      return new Promise((resolve) => {
        resolveList = resolve;
      });
    },
    async message() {
      return null;
    },
  });
  try {
    f.manager.startBackground();
    t.mock.timers.tick(0);
    await Promise.resolve();
    f.manager.settings({ enabled: false, autoUpdate: true });
    resolveList({ ids: [], nextPageToken: "second" });
    for (let index = 0; index < 10 && calls < 2; index++)
      await Promise.resolve();
    resolveList({ ids: [], nextPageToken: "third" });
    await finishGmailCheck(f.manager);
    assert.equal(f.manager.state().nextCheckAt, undefined);
    t.mock.timers.tick(gmailCheckIntervalMs * 2);
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test("generic background failures wait fifteen minutes before retrying", async (t) => {
  const currentTime = Date.now();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: currentTime });
  let calls = 0;
  const f = gmailFixture({
    async list() {
      calls++;
      if (calls === 1) throw new GmailError("Temporary Gmail failure");
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    f.manager.startBackground();
    t.mock.timers.tick(0);
    await finishGmailCheck(f.manager);
    assert.equal(
      f.manager.state().nextCheckAt,
      new Date(currentTime + gmailCheckIntervalMs).toISOString(),
    );
    t.mock.timers.tick(gmailCheckIntervalMs - 1);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await finishGmailCheck(f.manager);
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test("persisted page tokens reject a non-adjacent cursor cycle across passes", async (t) => {
  const cursors: (string | undefined)[] = [];
  const f = gmailFixture({
    async list(_query, cursor) {
      cursors.push(cursor);
      if (!cursor) return { ids: [], nextPageToken: "a" };
      if (cursor === "a") return { ids: [], nextPageToken: "b" };
      return { ids: [], nextPageToken: "a" };
    },
    async message() {
      return null;
    },
  });
  try {
    f.manager.check(true);
    await finishGmailCheck(f.manager);
    assert.deepEqual(
      f.store.get("gmail_scan", account)!.pending!.seenPageTokens,
      ["a"],
    );
    const later = Date.now() + 61_000;
    t.mock.method(Date, "now", () => later);
    f.manager.check(true);
    await finishGmailCheck(f.manager);
    assert.deepEqual(cursors, [undefined, "a", "b"]);
    assert.match(f.manager.state().error!, /repeated a page cursor/);
    assert.equal(f.manager.state().lastCheckedAt, undefined);
    assert.equal(f.store.get("gmail_scan", account)!.pending!.pageToken, "b");
  } finally {
    await f.close();
  }
});

test("an expired authorization asks for reconnection until a later check succeeds", async (t) => {
  let expired = true;
  const f = gmailFixture({
    async list() {
      if (expired)
        throw new GmailReconnectError(
          "Gmail authorization expired or was revoked.",
        );
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    f.manager.check(true);
    await finishGmailCheck(f.manager);
    assert.equal(f.manager.state().reconnectRequired, true);
    assert.match(f.manager.state().error!, /expired or was revoked/);
    expired = false;
    const later = Date.now() + 61_000;
    t.mock.method(Date, "now", () => later);
    f.manager.check(true);
    await finishGmailCheck(f.manager);
    assert.equal(f.manager.state().reconnectRequired, false);
    assert.equal(f.manager.state().error, undefined);
  } finally {
    await f.close();
  }
});

test("a saved interval change recomputes the check that is already waiting", async (t) => {
  const currentTime = Date.now();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: currentTime });
  const cursors: (string | undefined)[] = [];
  const f = gmailFixture({
    async list(_query, cursor) {
      cursors.push(cursor);
      return { ids: [] };
    },
    async message() {
      return null;
    },
  });
  try {
    f.store.put("gmail_scan", account, {
      account,
      lastAttemptAt: new Date(currentTime - 60_000).toISOString(),
    });
    f.manager.startBackground();
    t.mock.timers.tick(0);
    assert.deepEqual(cursors, [], "not due yet at the 15 minute interval");
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "gmail.checkIntervalMin": 2 },
    });
    f.manager.rescheduleBackground();
    t.mock.timers.tick(58_999);
    assert.deepEqual(cursors, []);
    t.mock.timers.tick(1_001);
    await finishGmailCheck(f.manager);
    assert.deepEqual(cursors, [undefined]);
  } finally {
    await f.close();
  }
});

test("next automatic check uses the current interval", async () => {
  const f = gmailFixture({
    list: async () => ({ ids: [] }),
    message: async () => null,
  });
  try {
    const last = new Date(Date.now() - 60_000).toISOString();
    f.store.put("gmail_scan", account, { account, lastAttemptAt: last });
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "gmail.checkIntervalMin": 3 },
    });
    assert.equal(
      f.manager.state().nextCheckAt,
      new Date(Date.parse(last) + 180_000).toISOString(),
    );
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "gmail.checkIntervalMin": 4 },
    });
    assert.equal(
      f.manager.state().nextCheckAt,
      new Date(Date.parse(last) + 240_000).toISOString(),
    );
  } finally {
    await f.close();
  }
});
