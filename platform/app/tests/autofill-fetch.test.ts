import test from "node:test";
import assert from "node:assert/strict";
import { fetchAutofillPage } from "../server/autofill/fetch.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import type { CareersResponse } from "../server/careers/http.js";

const url = "https://job-boards.greenhouse.io/example/jobs/123";
const response = (status: number, retryAfter?: string): CareersResponse => ({
  url,
  requestedUrl: url,
  status,
  retryAfter,
  type: "text/html",
  text: "fixture",
  at: new Date().toISOString(),
});

test("three parallel autofill generations survive one temporary Greenhouse connection failure", async () => {
  const fixtures = Array.from({ length: 3 }, applicationAnswerFixture);
  const attempts = [0, 0, 0];
  try {
    const records = await Promise.all(
      fixtures.map(async (f, i) => {
        return generateAutofill(f.store, "one", (value) =>
          fetchAutofillPage(value, new AbortController().signal, {
            read: async (requested) => {
              if (requested === url && ++attempts[i] === 1 && i === 1)
                throw Object.assign(new Error("connection reset"), {
                  code: "ECONNRESET",
                });
              return f.read(requested);
            },
            wait: async () => {},
          }),
        );
      }),
    );
    assert.equal(records.length, 3);
    assert.deepEqual(attempts, [1, 2, 1]);
    records.forEach((record, i) =>
      assert.ok(fixtures[i].store.get("application_autofill", record.id)),
    );
  } finally {
    fixtures.forEach((f) => f.cleanup());
  }
});

test("exhausted timeouts preserve the endpoint and actual cause in generation errors", async () => {
  const f = applicationAnswerFixture();
  let calls = 0;
  try {
    await assert.rejects(
      generateAutofill(f.store, "one", (value) =>
        fetchAutofillPage(value, new AbortController().signal, {
          read: async (requested) => {
            if (requested !== url) return f.read(requested);
            calls++;
            throw new DOMException("Request timed out", "TimeoutError");
          },
          wait: async () => {},
        }),
      ),
      /application form after 3 attempts.*timed out/,
    );
    assert.equal(calls, 3);
    assert.equal(f.store.list("application_autofill").length, 0);
  } finally {
    f.cleanup();
  }
});

test("temporary HTTP failures retry, while rate limits, permanent failures and unsafe requests do not", async () => {
  let calls = 0;
  const waits: number[] = [];
  await fetchAutofillPage(url, new AbortController().signal, {
    read: async () => response(++calls === 1 ? 503 : 200),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
  for (const status of [429, 403, 404]) {
    calls = 0;
    const pending = fetchAutofillPage(url, new AbortController().signal, {
      read: async () => {
        calls++;
        return response(status, status === 429 ? "300" : undefined);
      },
      wait: async () => {
        assert.fail(
          "Must not retry before a server cooldown or retry a permanent response",
        );
      },
    });
    if (status === 429) await assert.rejects(pending, /Retry after/);
    else assert.equal((await pending).status, status);
    assert.equal(calls, 1);
  }
  await assert.rejects(
    fetchAutofillPage(url, new AbortController().signal, {
      read: async () => {
        throw new Error(
          "Careers URL resolves to a private or unsupported address",
        );
      },
      wait: async () => {
        assert.fail("Unsafe requests must never retry");
      },
    }),
    /private/,
  );
});

test("reload cancellation stops a pending read retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchAutofillPage(url, controller.signal, {
      read: async () => {
        calls++;
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
      wait: async () => {
        controller.abort(new Error("Reload cancelled generation"));
      },
    }),
    /Reload cancelled/,
  );
  assert.equal(calls, 1);
});
