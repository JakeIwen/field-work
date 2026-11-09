import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import express from "express";
import { proxyCompanionRequest } from "../server/companion-http.js";

async function fixture(
  handler: http.RequestListener,
  recovery: Parameters<typeof proxyCompanionRequest>[4] = {},
) {
  const upstream = http.createServer(handler);
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  assert(address && typeof address === "object");
  const app = express();
  app.use((req, res) =>
    proxyCompanionRequest(
      req,
      res,
      {
        host: "127.0.0.1",
        port: address.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      "Unavailable fixture upstream",
      recovery,
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const bound = server.address();
  assert(bound && typeof bound === "object");
  return {
    url: `http://127.0.0.1:${bound.port}`,
    close: async () => {
      server.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    },
  };
}

test("disconnect before upstream headers cancels the pending upstream", async () => {
  const events = new EventEmitter();
  const received = once(events, "received");
  const closed = once(events, "closed");
  const f = await fixture((_req, res) => {
    res.once("close", () => events.emit("closed"));
    events.emit("received");
  });
  const controller = new AbortController();
  const response = fetch(f.url, { signal: controller.signal });
  void response.catch(() => {});
  try {
    await received;
    controller.abort();
    await response.catch(() => {});
    assert.equal(
      await Promise.race([
        closed.then(() => "closed"),
        delay(500).then(() => "timed out"),
      ]),
      "closed",
    );
  } finally {
    controller.abort();
    await f.close();
  }
});

test("a reset before headers retries a bodyless read once", async () => {
  let calls = 0;
  const f = await fixture(
    (_req, res) => {
      if (++calls === 1) res.destroy();
      else res.end("recovered");
    },
    { retryReads: true, retryDelayMs: 1 },
  );
  try {
    const response = await fetch(f.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "recovered");
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test("a lost write acknowledgement never repeats the mutation", async () => {
  let saved = 0;
  const f = await fixture(
    (req, res) => {
      req.resume();
      req.once("end", () => {
        saved++;
        res.destroy();
      });
    },
    { retryReads: true, retryDelayMs: 1 },
  );
  try {
    const response = await fetch(f.url, { method: "POST", body: "saved once" });
    assert.equal(response.status, 503);
    await response.text();
    assert.equal(saved, 1);
  } finally {
    await f.close();
  }
});

test("disconnecting during backoff cancels the scheduled read", async () => {
  let calls = 0;
  const received = new EventEmitter();
  const first = once(received, "first");
  const f = await fixture(
    (_req, res) => {
      calls++;
      res.destroy();
      received.emit("first");
    },
    { retryReads: true, retryDelayMs: 150 },
  );
  const controller = new AbortController();
  const pending = fetch(f.url, { signal: controller.signal });
  void pending.catch(() => {});
  try {
    await first;
    await delay(20);
    controller.abort();
    await assert.rejects(pending);
    await delay(180);
    assert.equal(calls, 1);
  } finally {
    controller.abort();
    await f.close();
  }
});

test("unresponsive reads have bounded attempts and release upstream requests", async () => {
  let opened = 0,
    closed = 0;
  const f = await fixture(
    (_req, res) => {
      opened++;
      res.once("close", () => {
        closed++;
      });
    },
    { retryReads: true, retryDelayMs: 1, readTimeoutMs: 40 },
  );
  try {
    const response = await fetch(f.url, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 503);
    await response.text();
    await delay(20);
    assert.equal(opened, 2);
    assert.equal(closed, 2);
  } finally {
    await f.close();
  }
});

test("a truncated successful response is never retried", async () => {
  let calls = 0;
  const f = await fixture(
    (_req, res) => {
      calls++;
      res.writeHead(200);
      res.write("partial");
      setTimeout(() => res.destroy(), 20);
    },
    { retryReads: true, retryDelayMs: 1 },
  );
  try {
    const response = await fetch(f.url);
    await assert.rejects(response.text());
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("truncated upstream responses terminate downstream streams", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200);
    res.write("partial");
    setTimeout(() => res.destroy(), 20);
  });
  const controller = new AbortController();
  try {
    const response = await fetch(f.url, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(
      await Promise.race([
        response.text().then(
          () => "unexpected success",
          () => "failed",
        ),
        delay(500).then(() => "timed out"),
      ]),
      "failed",
    );
  } finally {
    controller.abort();
    await f.close();
  }
});

test("upstream failure before headers returns a bounded unavailable response", async () => {
  const f = await fixture((_req, res) => res.destroy());
  try {
    const response = await fetch(f.url);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Unavailable fixture upstream",
    });
  } finally {
    await f.close();
  }
});
