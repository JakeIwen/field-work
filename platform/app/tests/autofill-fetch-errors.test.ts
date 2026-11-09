import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import {
  autofillReader,
  fetchAutofillPage,
  settledGreenhousePages,
} from "../server/autofill/fetch.js";
import {
  describeAutofillFetchFailure,
  type AutofillFetchAttempt,
} from "../server/autofill/fetch-errors.js";

test("read journals omit only first-attempt successes and retain retries, recovery and failure", async () => {
  const f = applicationAnswerFixture();
  try {
    const read = autofillReader(f.store, "one", { read: async () => page });
    assert.equal((await read(url)).status, 200);
    assert.equal(f.store.list("journal").length, 0);
    let attempts = 0;
    const retry = autofillReader(f.store, "one", {
      read: async () => {
        if (++attempts === 1)
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return page;
      },
      wait: async () => {},
    });
    await retry(url);
    const failed = autofillReader(f.store, "one", {
      read: async () => {
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
      wait: async () => {},
    });
    await assert.rejects(failed(url), /after 3 attempts/);
    assert.deepEqual(
      f.store.list("journal").map((entry) => entry.message),
      [
        "Greenhouse read retrying (attempt 1)",
        "Greenhouse read succeeded (attempt 2)",
        "Greenhouse read retrying (attempt 1)",
        "Greenhouse read retrying (attempt 2)",
        "Greenhouse read failed (attempt 3)",
      ],
    );
  } finally {
    f.cleanup();
  }
});

const url = "https://job-boards.greenhouse.io/example/jobs/123";
const page = {
  url,
  requestedUrl: url,
  status: 200,
  type: "text/html",
  text: "fixture",
  at: "2026-10-08",
};

async function nodeHttpTimeout(): Promise<Error> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await new Promise<Error>((resolve) => {
      get(`http://127.0.0.1:${address.port}/`, {
        signal: AbortSignal.timeout(30),
        agent: false,
      }).on("error", resolve);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("actual Node HTTP timeout wrappers retry and retain their nested cause", async () => {
  const error = await nodeHttpTimeout();
  assert.equal(error.name, "AbortError");
  assert.ok(error.cause instanceof Error);
  assert.equal(error.cause.name, "TimeoutError");
  let reads = 0;
  const attempts: AutofillFetchAttempt[] = [];
  const response = await fetchAutofillPage(url, new AbortController().signal, {
    read: async () => {
      if (++reads === 1) throw error;
      return page;
    },
    wait: async () => {},
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(response.status, 200);
  assert.equal(reads, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.outcome),
    ["retrying", "succeeded"],
  );
  assert.equal(attempts[0].causes?.[0].name, "AbortError");
  assert.equal(attempts[0].causes?.[1].name, "TimeoutError");
  assert.equal(attempts[0].retryDelayMs, 1000);
});

test("exhausted wrapped timeouts retain the endpoint, attempts and cause", async () => {
  const error = Object.assign(
    new Error("The operation was aborted", {
      cause: new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
  const attempts: AutofillFetchAttempt[] = [];
  await assert.rejects(
    fetchAutofillPage(url, new AbortController().signal, {
      read: async () => {
        throw error;
      },
      wait: async () => {},
      onAttempt: (attempt) => attempts.push(attempt),
    }),
    /application form after 3 attempts.*ABORT_ERR.*TimeoutError/,
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.outcome),
    ["retrying", "retrying", "failed"],
  );
});

test("aggregate connection and DNS errors retry, but certificate and policy failures do not", async () => {
  const network = new AggregateError([
    Object.assign(new Error("connect failed"), { code: "ENETUNREACH" }),
    Object.assign(new Error("name lookup failed"), { code: "ENOTFOUND" }),
  ]);
  assert.equal(describeAutofillFetchFailure(network).temporary, true);
  const certificate = Object.assign(new Error("certificate expired"), {
    code: "CERT_HAS_EXPIRED",
  });
  assert.equal(
    describeAutofillFetchFailure(new AggregateError([network, certificate]))
      .temporary,
    false,
  );
  let calls = 0;
  await assert.rejects(
    fetchAutofillPage(url, new AbortController().signal, {
      read: async () => {
        calls++;
        throw certificate;
      },
      wait: async () => assert.fail("Do not retry certificate failures"),
    }),
    /CERT_HAS_EXPIRED/,
  );
  assert.equal(calls, 1);
  assert.throws(
    () =>
      settledGreenhousePages([
        {
          status: "rejected",
          reason: new Error("Unsupported careers response encoding"),
        },
      ]),
    /Unsupported careers response encoding/,
  );
});

test("user cancellation is never mistaken for a retryable wrapped timeout", async () => {
  const controller = new AbortController();
  const attempts: AutofillFetchAttempt[] = [];
  await assert.rejects(
    fetchAutofillPage(url, controller.signal, {
      read: async () => {
        controller.abort(new Error("Cancelled by user"));
        throw new Error("The operation was aborted", {
          cause: new DOMException("timed out", "TimeoutError"),
        });
      },
      wait: async () => assert.fail("Cancellation must not retry"),
      onAttempt: (attempt) => attempts.push(attempt),
    }),
    /Cancelled by user/,
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.outcome),
    ["cancelled"],
  );
});
