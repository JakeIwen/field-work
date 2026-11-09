import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/storage.js";
import { openingApplicationUrl } from "../server/routes/opening-application.js";
import type { CareersFetch } from "../server/careers/http.js";
import { opening } from "../client/testing/component-fixtures.js";

const url = "https://job-boards.greenhouse.io/example/jobs/123";
const direct =
  "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123";
const external = "https://careers.example.com/job?gh_jid=123";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opening-application-link-"));
  const store = new Store(root, path.join(root, ".local/data"));
  store.put("cache_opening", opening.id, { ...opening, url });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function reader(redirect = false): CareersFetch {
  return async (requestedUrl) => ({
    requestedUrl,
    url: redirect && requestedUrl === url ? external : requestedUrl,
    status: 200,
    type: "text/html",
    at: "2026-10-19T12:00:00Z",
    text: requestedUrl.includes("boards-api")
      ? JSON.stringify({
          id: 123,
          title: "Engineer",
          absolute_url: redirect ? external : url,
        })
      : '<main><input id="first_name"></main>',
  });
}

test("Opening navigation chooses the verified Greenhouse form without changing application work", async () => {
  const f = fixture();
  try {
    assert.equal(
      await openingApplicationUrl(f.store, opening.id, reader()),
      url,
    );
    assert.equal(
      await openingApplicationUrl(f.store, opening.id, reader(true)),
      direct,
    );
    assert.equal(f.store.opening(opening.id)?.url, url);
    assert.equal(f.store.list("application_autofill").length, 0);
    assert.equal(f.store.list("application").length, 0);
    await assert.rejects(
      openingApplicationUrl(f.store, "missing", reader()),
      /Opening not found/,
    );
    f.store.put("cache_opening", opening.id, { ...opening, url: external });
    await assert.rejects(
      openingApplicationUrl(f.store, opening.id, reader()),
      /not a hosted Greenhouse/,
    );
  } finally {
    f.cleanup();
  }
});

test("Opening navigation refuses unverified redirects, wrong forms and unavailable postings", async () => {
  const f = fixture();
  try {
    for (const [changedUrl, response, message] of [
      [
        url,
        { url: "https://unverified.example.org/job?gh_jid=123" },
        /different posting/,
      ],
      [
        direct,
        { url: direct.replace("token=123", "token=999") },
        /redirected unexpectedly/,
      ],
      [direct, { status: 429 }, /limiting requests/],
      [url, { status: 404 }, /no longer available|closed|not found/i],
    ] as const) {
      await assert.rejects(
        openingApplicationUrl(f.store, opening.id, async (u) => ({
          ...(await reader(true)(u)),
          ...(u === changedUrl ? response : {}),
        })),
        message,
      );
    }
    await assert.rejects(
      openingApplicationUrl(f.store, opening.id, async (u) => ({
        ...(await reader()(u)),
        ...(u.includes("boards-api")
          ? { text: '{"id":999,"title":"Wrong job"}' }
          : {}),
      })),
      /different or invalid job/,
    );
  } finally {
    f.cleanup();
  }
});

test("a documented employer hop can upgrade HTTP and move paths without changing the Greenhouse form", async () => {
  const f = fixture();
  const documented = "http://careers.example.com/job?gh_jid=123";
  const moved = "https://careers.example.com/about/jobs?gh_jid=123";
  const read: CareersFetch = async (u) => ({
    ...(await reader(true)(u)),
    ...(u.includes("boards-api")
      ? {
          text: JSON.stringify({
            id: 123,
            title: "Engineer",
            absolute_url: documented,
          }),
        }
      : {}),
    ...(u === url ? { url: moved, redirects: [documented, moved] } : {}),
  });
  try {
    assert.equal(
      await openingApplicationUrl(f.store, opening.id, read),
      direct,
    );
    await assert.rejects(
      openingApplicationUrl(f.store, opening.id, async (u) => ({
        ...(await read(u)),
        ...(u === url
          ? {
              redirects: [
                "https://unverified.example.org/job?gh_jid=123",
                documented,
                moved,
              ],
            }
          : {}),
      })),
      /different posting/,
    );
  } finally {
    f.cleanup();
  }
});

test("an employer denying server reads still opens its verified public Greenhouse form", async () => {
  const f = fixture();
  const denied: CareersFetch = async (u) => ({
    ...(await reader(true)(u)),
    ...(u === url ? { status: 403, redirects: [external] } : {}),
  });
  try {
    assert.equal(
      await openingApplicationUrl(f.store, opening.id, denied),
      direct,
    );
    await assert.rejects(
      openingApplicationUrl(f.store, opening.id, async (u) => ({
        ...(await denied(u)),
        ...(u === direct ? { status: 403 } : {}),
      })),
      /HTTP 403/,
    );
    await assert.rejects(
      openingApplicationUrl(f.store, opening.id, async (u) => ({
        ...(await reader()(u)),
        ...(u === url ? { status: 403 } : {}),
      })),
      /HTTP 403/,
    );
    await assert.rejects(
      openingApplicationUrl(f.store, opening.id, async (u) => ({
        ...(await denied(u)),
        ...(u === url
          ? { redirects: ["https://unverified.example.org/job?gh_jid=123"] }
          : {}),
      })),
      /different posting/,
    );
  } finally {
    f.cleanup();
  }
});
