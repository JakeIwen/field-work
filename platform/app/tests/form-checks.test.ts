import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  startFormCheckPass,
  enqueueFormChecks,
  activeFormCheckPass,
} from "../server/autofill/form-checks.js";
import { abortGenerations } from "../server/generation-control.js";
import { atomicWrite } from "../server/storage.js";
import { readAutofillProfile } from "../server/autofill/profile.js";
import { openingFormChecksPath } from "../shared/opening-form-check.js";
import {
  applicationAnswerFixture,
  url,
} from "./fixtures/application-answers-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { opening } from "../client/testing/component-fixtures.js";
import type { Store } from "../server/storage.js";

async function settled(store: Store) {
  for (let i = 0; i < 300 && activeFormCheckPass(store); i++) await pause(20);
  assert.equal(
    activeFormCheckPass(store),
    undefined,
    "form-check pass must settle",
  );
}

const currentOpening = { ...opening, id: "one", url, hash: "opening" };

function seedPassTargets(store: Store) {
  for (const [id, jobId] of [
    ["two", "999"],
    ["one", "123"],
    ["dismissed", "222"],
    ["closed", "333"],
  ])
    store.put("custom_opening", id, {
      ...currentOpening,
      id,
      url: url.replace("123", jobId),
    });
  store.put("personal", "dismissed", { version: 1, dismissed: true });
  store.put("opening_validation", "closed", {
    id: "closed",
    url: url.replace("123", "333"),
    status: "closed",
    confirmedStatus: "closed",
    checkedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    reason: "Fixture closure",
    evidenceHashes: [],
    runId: "fixture",
  });
  store.put("custom_opening", "unsupported", {
    ...currentOpening,
    id: "unsupported",
    url: "https://example.test/job",
  });
}

test("form-check endpoint deduplicates a paced pass, guards writes and records per-Opening failures", async () => {
  const f = applicationAnswerFixture();
  f.store.remove("task", f.task.id);
  f.store.remove("cache_opening", "one");
  const w = await openFixtureWorkspace(f.root);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const empty = await w.post(openingFormChecksPath);
    assert.equal(empty.status, 202);
    assert.equal((await empty.json()).queued, 0);
    await settled(w.store);
    seedPassTargets(w.store);
    const requests: { url: string; at: number }[] = [];
    const external = "https://careers.example.test/job?gh_jid=123";
    const pass = startFormCheckPass(
      w.store,
      () => {},
      async (requested) => {
        requests.push({ url: requested, at: Date.now() });
        await gate;
        const page = await f.read(requested);
        if (requested.includes("999")) return { ...page, status: 404 };
        if (requested.includes("boards-api"))
          return {
            ...page,
            text: JSON.stringify({ ...f.api, absolute_url: external }),
          };
        return requested === url
          ? { ...page, url: external, status: 403, redirects: [external] }
          : page;
      },
    );
    assert.equal(pass.queued, 2);
    const duplicate = await w.post(openingFormChecksPath);
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), pass);
    const activity = await (await w.get("/api/system/activity")).json();
    assert.ok(
      activity.remaining.some(
        (item: { id: string }) => item.id === "form-checks",
      ),
    );
    const sessionUrl = (await w.get("/api/session")).url;
    const forbidden = await fetch(new URL(openingFormChecksPath, sessionUrl), {
      method: "POST",
    });
    assert.equal(forbidden.status, 403);
    release();
    await settled(w.store);
    assert.equal(w.store.get("opening_form_check", "one")?.status, "ok");
    assert.equal(w.store.get("opening_form_check", "one")?.narrative, 1);
    assert.equal(w.store.get("opening_form_check", "two")?.status, "failed");
    assert.match(
      w.store.get("opening_form_check", "two")?.error ?? "",
      /closed|available/i,
    );
    assert.equal(w.store.list("opening_form_check").length, 2);
    assert.equal(
      requests.filter((r) => r.url.includes("embed/job_app")).length,
      1,
    );
    for (let i = 1; i < requests.length; i++)
      assert.ok(
        requests[i].at - requests[i - 1].at >= 1000,
        "all API/hosted/direct requests must be paced",
      );
    assert.equal(w.store.list("task").length, 0);
    assert.equal(w.store.list("application").length, 0);
    assert.equal(w.store.list("application_autofill").length, 0);
  } finally {
    release();
    await w.close();
    f.cleanup();
  }
});

test("state omits failed, changed-Opening and file-dependent stale-profile checks", async () => {
  const f = applicationAnswerFixture();
  f.store.remove("task", f.task.id);
  f.store.remove("cache_opening", "one");
  const w = await openFixtureWorkspace(f.root);
  try {
    w.store.put("custom_opening", "one", currentOpening);
    const result = {
      openingId: "one",
      checkedAt: new Date().toISOString(),
      openingHash: "opening",
      profileHash: readAutofillProfile(w.store).hash,
      status: "ok" as const,
      personal: [{ label: "Confirm accuracy", reason: "Acknowledge yourself" }],
      narrative: 2,
    };
    w.store.put("opening_form_check", "one", result);
    const state = async () =>
      (await (await w.get("/api/state")).json()).openingFormChecks;
    assert.deepEqual(await state(), {
      one: { personal: result.personal, narrative: 2 },
    });
    w.store.put("opening_form_check", "one", {
      ...result,
      status: "failed",
      error: "Unreadable form",
    });
    assert.deepEqual(await state(), {});
    w.store.put("opening_form_check", "one", result);
    w.store.put("custom_opening", "one", {
      ...currentOpening,
      hash: "changed",
    });
    assert.deepEqual(await state(), {});
    w.store.put("custom_opening", "one", currentOpening);
    assert.ok((await state()).one);
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({
        version: 1,
        firstName: "Changed",
        email: "test@example.com",
      }),
    );
    assert.deepEqual(
      await state(),
      {},
      "file changes must not hide behind Store caching",
    );
    w.store.put("opening_form_check", "one", {
      ...result,
      profileHash: readAutofillProfile(w.store).hash,
    });
    assert.ok((await state()).one);
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      "invalid JSON",
    );
    assert.deepEqual(await state(), {});
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("deletion during a form check is not resurrected and shutdown drains the pass", async () => {
  const f = applicationAnswerFixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    startFormCheckPass(
      f.store,
      () => {},
      async (requested) => {
        await gate;
        return f.read(requested);
      },
    );
    await pause(0);
    f.store.remove("cache_opening", "one");
    release();
    await abortGenerations(f.store);
    assert.equal(activeFormCheckPass(f.store), undefined);
    assert.equal(f.store.get("opening_form_check", "one"), undefined);
  } finally {
    release();
    await abortGenerations(f.store);
    f.cleanup();
  }
});

test("enqueue joins a running pass without duplicating queued ids and starts one when idle", async () => {
  const f = applicationAnswerFixture();
  f.store.remove("task", f.task.id);
  f.store.remove("cache_opening", "one");
  const w = await openFixtureWorkspace(f.root);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    seedPassTargets(w.store);
    const read = async (requested: string) => {
      await gate;
      return f.read(requested);
    };
    assert.equal(
      enqueueFormChecks(w.store, ["missing"], () => {}, read),
      undefined,
    );
    assert.equal(activeFormCheckPass(w.store), undefined);
    const idle = enqueueFormChecks(
      w.store,
      ["one", "one", "unsupported", "dismissed"],
      () => {},
      read,
    )!;
    assert.equal(
      idle.queued,
      1,
      "only the supported, active Opening starts a pass",
    );
    assert.equal(idle.running, true);
    const joined = enqueueFormChecks(w.store, ["two", "two"], () => {}, read)!;
    assert.equal(joined.queued, 2);
    assert.equal(
      enqueueFormChecks(w.store, ["two"], () => {}, read)!.queued,
      2,
      "an id still queued is not added twice",
    );
    assert.equal(activeFormCheckPass(w.store)?.queued, 2);
    release();
    await settled(w.store);
    assert.deepEqual(
      w.store
        .list("opening_form_check")
        .map((c) => c.openingId)
        .sort(),
      ["one", "two"],
    );
    assert.equal(activeFormCheckPass(w.store), undefined);
  } finally {
    release();
    await w.close();
    f.cleanup();
  }
});
