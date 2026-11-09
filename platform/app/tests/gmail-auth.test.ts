import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { GmailAuth } from "../server/gmail/auth.js";
import {
  gmailReadScope,
  gmailSettingsScope,
  gmailAuthorizationScopes,
  gmailReader,
  googleJson,
} from "../server/gmail/api.js";

test("OAuth requests read and filter settings access, PKCE and one-use state; credentials remain private and survive refresh", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-gmail-auth-"));
  const auth = new GmailAuth(root, 4317);
  let refreshes = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/profile"))
      return Response.json({ emailAddress: "Candidate@Example.net" });
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init.body));
    if (body.get("grant_type") === "refresh_token") {
      refreshes++;
      return Response.json({ access_token: "refreshed", expires_in: 3600 });
    }
    assert.ok(body.get("code_verifier")!.length >= 43);
    assert.equal(body.get("redirect_uri"), auth.redirectUri);
    return Response.json({
      access_token: "private-access",
      expires_in: 3600,
      refresh_token: "private-refresh",
      scope: gmailAuthorizationScopes.join(" "),
    });
  });
  try {
    assert.throws(() => auth.configure({ web: {} }), /Desktop/);
    auth.configure({
      installed: {
        client_id: "fixture.apps.googleusercontent.com",
        client_secret: "private-client",
      },
    });
    const start = new URL(auth.start().url);
    assert.equal(
      start.searchParams.get("scope"),
      gmailAuthorizationScopes.join(" "),
    );
    assert.equal(start.searchParams.get("code_challenge_method"), "S256");
    assert.equal(start.searchParams.get("access_type"), "offline");
    assert.ok(!start.toString().includes("private-client"));
    await assert.rejects(
      auth.finish("wrong", "code", undefined),
      /does not match/,
    );
    await auth.finish(start.searchParams.get("state"), "code", undefined);
    await assert.rejects(
      auth.finish(start.searchParams.get("state"), "code", undefined),
      /does not match/,
    );
    assert.equal(auth.state().account, "candidate@example.net");
    assert.equal(auth.state().filterSettingsGranted, true);
    assert.equal(auth.state().sendGranted, true);
    assert.equal(
      statSync(path.join(root, "gmail/tokens.json")).mode & 0o777,
      0o600,
    );
    assert.ok(!JSON.stringify(auth.state()).includes("private-"));
    const restored = new GmailAuth(root, 4317);
    assert.deepEqual(await Promise.all([restored.token(), restored.token()]), [
      "refreshed",
      "refreshed",
    ]);
    assert.equal(refreshes, 1);
    assert.equal(restored.state().filterSettingsGranted, true);
    restored.disconnect();
    assert.equal(restored.state().connected, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("denied or wrong-scope authorization never creates a connection; upstream errors do not leak tokens", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-gmail-denied-"));
  const auth = new GmailAuth(root, 4317);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      access_token: "private",
      refresh_token: "secret",
      expires_in: 3600,
      scope: "unrelated",
    }),
  );
  try {
    auth.configure({
      installed: {
        client_id: "fixture.apps.googleusercontent.com",
        client_secret: "private-client",
      },
    });
    let start = new URL(auth.start().url);
    await assert.rejects(
      auth.finish(start.searchParams.get("state"), undefined, "access_denied"),
      /cancelled/,
    );
    start = new URL(auth.start().url);
    await assert.rejects(
      auth.finish(start.searchParams.get("state"), "code", undefined),
      /not all granted/,
    );
    assert.equal(auth.state().connected, false);
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ error_description: "private-token" }, { status: 400 }),
    );
    await assert.rejects(
      googleJson("https://oauth2.googleapis.com/token"),
      (error) =>
        error instanceof Error && !error.message.includes("private-token"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gmail API validates pages, follows opaque cursors and only uses GET for mailbox access", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(init.method, undefined);
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      "Bearer private",
    );
    assert.ok(
      url.startsWith(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?",
      ),
    );
    const params = new URL(url).searchParams;
    if (calls === 1) {
      assert.equal(params.get("q"), "interview");
      return Response.json({
        messages: [{ id: "abcd" }],
        nextPageToken: "opaque+/=",
      });
    }
    assert.equal(params.get("pageToken"), "opaque+/=");
    return Response.json({ messages: "invalid" });
  });
  const reader = gmailReader(async () => "private");
  const page = await reader.list("interview");
  assert.deepEqual(page.ids, ["abcd"]);
  await assert.rejects(
    reader.list("interview", page.nextPageToken),
    /invalid message list/,
  );
});

test("legacy connections survive cancelled and partial upgrades; only a full grant enables filters", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-gmail-upgrade-"));
  const auth = new GmailAuth(root, 4317);
  const tokenFile = path.join(root, "gmail/tokens.json");
  let scope = gmailReadScope;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/profile"))
      return Response.json({ emailAddress: "candidate@example.net" });
    const refresh =
      new URLSearchParams(String(init.body)).get("grant_type") ===
      "refresh_token";
    return Response.json({
      access_token: "access",
      expires_in: 3600,
      ...(refresh ? {} : { refresh_token: "new-refresh", scope }),
    });
  });
  try {
    auth.configure({
      installed: {
        client_id: "fixture.apps.googleusercontent.com",
        client_secret: "private-client",
      },
    });
    const legacy = JSON.stringify({
      refreshToken: "old-refresh",
      account: "candidate@example.net",
    });
    writeFileSync(tokenFile, legacy, { mode: 0o600 });
    assert.equal(auth.state().connected, true);
    assert.equal(auth.state().filterSettingsGranted, false);
    assert.equal(await auth.token(), "access");
    let start = new URL(auth.start().url);
    await assert.rejects(
      auth.finish(start.searchParams.get("state"), undefined, "access_denied"),
      /cancelled/,
    );
    assert.equal(readFileSync(tokenFile, "utf8"), legacy);
    // Read plus filter settings was the previous full grant; it no longer includes sending.
    for (const partial of [
      gmailReadScope,
      gmailSettingsScope,
      `${gmailReadScope} ${gmailSettingsScope}`,
    ]) {
      scope = partial;
      start = new URL(auth.start().url);
      await assert.rejects(
        auth.finish(start.searchParams.get("state"), "code", undefined),
        /all granted/,
      );
      assert.equal(readFileSync(tokenFile, "utf8"), legacy);
      assert.equal(auth.state().filterSettingsGranted, false);
      assert.equal(await auth.token(), "access");
    }
    scope = [...gmailAuthorizationScopes].reverse().join(" ");
    start = new URL(auth.start().url);
    await auth.finish(start.searchParams.get("state"), "code", undefined);
    assert.equal(auth.state().filterSettingsGranted, true);
    assert.equal(auth.state().sendGranted, true);
    assert.equal(auth.state().error, undefined);
    assert.equal(new GmailAuth(root, 4317).state().filterSettingsGranted, true);
    auth.disconnect();
    assert.equal(auth.state().filterSettingsGranted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gmail reader includes archived incoming thread context without sent, spam, trash or drafts", async (t) => {
  const make = (id: string, labels: string[]) => ({
    id,
    threadId: "abcd",
    internalDate: String(Date.now()),
    labelIds: labels,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "recruiter@example.com" },
        { name: "Subject", value: "Application" },
      ],
      body: {
        data: Buffer.from("Please choose a time.").toString("base64url"),
      },
    },
  });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    assert.match(url, /threads\/abcd\?format=full$/);
    return Response.json({
      messages: [
        make("a1", []),
        make("a2", ["INBOX"]),
        make("a3", ["SENT"]),
        make("a4", ["SPAM"]),
        make("a5", ["TRASH"]),
        make("a6", ["DRAFT"]),
      ],
    });
  });
  const reader = gmailReader(async () => "private");
  assert.deepEqual(
    (await reader.thread!("abcd")).map((message) => message.id),
    ["a1", "a2"],
  );
});

test("Gmail reader rejects malformed or mismatched thread context and safely ignores removed threads", async (t) => {
  let response: unknown = { messages: "invalid" };
  let status = 200;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(response, { status }),
  );
  const reader = gmailReader(async () => "private");
  await assert.rejects(reader.thread!("abcd"), /invalid conversation/);
  response = {
    messages: [
      {
        id: "a1",
        threadId: "def0",
        internalDate: String(Date.now()),
        payload: { headers: [] },
      },
    ],
  };
  await assert.rejects(reader.thread!("abcd"), /different conversation/);
  status = 404;
  response = { error: { code: 404 } };
  assert.deepEqual(await reader.thread!("abcd"), []);
});

test("authorization returns only to known in-app pages", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-gmail-return-"));
  const auth = new GmailAuth(root, 4317);
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.endsWith("/profile")
      ? Response.json({ emailAddress: "candidate@example.net" })
      : Response.json({
          access_token: "access",
          expires_in: 3600,
          refresh_token: "refresh",
          scope: gmailAuthorizationScopes.join(" "),
        }),
  );
  try {
    auth.configure({
      installed: {
        client_id: "fixture.apps.googleusercontent.com",
        client_secret: "private-client",
      },
    });
    for (const [requested, expected] of [
      [
        "#applications/00000000-0000-4000-8000-000000000042",
        "#applications/00000000-0000-4000-8000-000000000042",
      ],
      ["#replies", "#replies"],
      [undefined, "#settings"],
      ["https://attacker.example/#applications/x", "#settings"],
      ["#applications/x/../../", "#settings"],
    ] as const) {
      const start = new URL(auth.start(requested).url);
      assert.equal(
        await auth.finish(start.searchParams.get("state"), "code", undefined),
        expected,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
