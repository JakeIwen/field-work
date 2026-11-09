import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type {
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
  RequestOptions,
} from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  decodeGuardedResponse,
  guardedRequest,
  resolvePublicAddresses,
  type GuardedTransport,
} from "../server/guarded-http.js";
import {
  fetchPosting,
  postingUrl,
  publicAddress,
} from "../server/job-posting.js";

class FakeResponse extends EventEmitter {
  statusCode?: number;
  headers: IncomingHttpHeaders = {};
  destroyedWith?: Error;

  destroy(error?: Error) {
    this.destroyedWith = error;
    if (error) this.emit("error", error);
    return this;
  }
}

class FakeRequest extends EventEmitter {
  destroyedWith?: Error;
  endedWith?: Buffer;

  constructor(private readonly respond: () => void) {
    super();
  }

  destroy(error?: Error) {
    this.destroyedWith = error;
    if (error) this.emit("error", error);
    return this;
  }

  end(data?: Buffer) {
    this.endedWith = data;
    this.respond();
    return this;
  }
}

function mockedTransport(response: FakeResponse, chunks: Buffer[]) {
  let requestOptions: RequestOptions | undefined;
  let request: FakeRequest | undefined;
  const transport: GuardedTransport = (_url, options, onResponse) => {
    requestOptions = options;
    request = new FakeRequest(() => {
      for (const chunk of chunks) response.emit("data", chunk);
      response.emit("end");
    });
    onResponse(response);
    return request;
  };
  return {
    transport,
    options: () => requestOptions,
    request: () => request,
  };
}

const headers: OutgoingHttpHeaders = {
  "User-Agent": "test reader",
  Accept: "text/plain",
  "Accept-Encoding": "identity",
};

test("guarded request keeps caller-specific lookup, defaults, payload and overflow policies", async () => {
  const response = new FakeResponse();
  response.statusCode = Number.NaN;
  response.headers = { "content-type": "text/plain" };
  const mock = mockedTransport(response, [Buffer.from("ok")]);
  const payload = Buffer.from("payload");
  const result = await guardedRequest({
    url: new URL("https://example.com/jobs"),
    address: { address: "8.8.8.8", family: 4 },
    signal: new AbortController().signal,
    agent: false,
    method: "POST",
    headers,
    payload,
    endPayload: "pass",
    lookupPolicy: "always-array",
    requestOptionOrder: "lookup-headers",
    responseDefaults: "falsy",
    maxBytes: 10,
    overflowMessage: "too large",
    overflowTarget: "request",
    transport: mock.transport,
  });
  assert.equal(result.status, 0);
  assert.equal(result.bytes.toString(), "ok");
  assert.deepEqual(mock.request()?.endedWith, payload);
  assert.equal(mock.options()?.method, "POST");
  assert.deepEqual(mock.options()?.headers, headers);
  assert.deepEqual(Object.keys(mock.options() ?? {}), [
    "method",
    "signal",
    "agent",
    "lookup",
    "headers",
  ]);
  let pinned: string | { address: string; family: number }[] | undefined;
  mock.options()?.lookup?.("example.com", { all: false }, (_error, value) => {
    pinned = value;
  });
  assert.deepEqual(pinned, [{ address: "8.8.8.8", family: 4 }]);

  const postingResponse = new FakeResponse();
  postingResponse.statusCode = Number.NaN;
  const postingMock = mockedTransport(postingResponse, [Buffer.from("ok")]);
  const posting = await guardedRequest({
    url: new URL("https://example.com/jobs"),
    address: { address: "1.1.1.1", family: 4 },
    signal: new AbortController().signal,
    agent: false,
    method: "GET",
    headers,
    endPayload: "omit",
    lookupPolicy: "honor-all",
    requestOptionOrder: "headers-lookup",
    responseDefaults: "nullish",
    maxBytes: 10,
    overflowMessage: "too large",
    overflowTarget: "response",
    transport: postingMock.transport,
  });
  assert.ok(Number.isNaN(posting.status));
  assert.deepEqual(Object.keys(postingMock.options() ?? {}), [
    "method",
    "signal",
    "agent",
    "headers",
    "lookup",
  ]);
  let address: string | { address: string; family: number }[] | undefined;
  let family: number | undefined;
  postingMock
    .options()
    ?.lookup?.("example.com", { all: false }, (_error, value, valueFamily) => {
      address = value;
      family = valueFamily;
    });
  assert.equal(address, "1.1.1.1");
  assert.equal(family, 4);
});

test("guarded request destroys the caller-selected stream on wire overflow", async () => {
  for (const target of ["response", "request"] as const) {
    const response = new FakeResponse();
    const mock = mockedTransport(response, [Buffer.from("too large")]);
    await assert.rejects(
      guardedRequest({
        url: new URL("https://example.com/jobs"),
        address: { address: "8.8.8.8", family: 4 },
        signal: new AbortController().signal,
        agent: false,
        method: "GET",
        headers,
        endPayload: "omit",
        lookupPolicy: "always-array",
        requestOptionOrder: "lookup-headers",
        responseDefaults: "falsy",
        maxBytes: 2,
        overflowMessage: `${target} overflow`,
        overflowTarget: target,
        transport: mock.transport,
      }),
      new RegExp(`${target} overflow`),
    );
    assert.equal(
      target === "response"
        ? response.destroyedWith?.message
        : mock.request()?.destroyedWith?.message,
      `${target} overflow`,
    );
  }
});

test("shared decoding preserves all supported encodings and caller error text", () => {
  const text = Buffer.from("shared guarded response body");
  for (const [encoding, compressed] of [
    ["gzip", gzipSync(text)],
    ["br", brotliCompressSync(text)],
    ["deflate", deflateSync(text)],
    ["identity", text],
  ] as const)
    assert.deepEqual(
      decodeGuardedResponse(compressed, encoding, {
        maxOutputLength: 1024,
        unsupportedEncodingMessage: "posting encoding",
      }),
      text,
    );
  assert.throws(
    () =>
      decodeGuardedResponse(text, "compress", {
        maxOutputLength: 1024,
        unsupportedEncodingMessage: "careers encoding",
      }),
    /careers encoding/,
  );
});

test("posting resolver injection remains an unbound call", async () => {
  let observedThis: unknown = "not called";
  await fetchPosting("https://example.com/job", {
    resolve: function (this: unknown) {
      observedThis = this;
      return Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
    },
    read: async () => ({
      status: 200,
      type: "text/plain",
      body: Buffer.from(
        "A source-backed software engineering posting. ".repeat(4),
      ),
    }),
  });
  assert.equal(observedThis, undefined);
});

test("shared DNS vetting rejects the entire answer set when any address is unsafe", async () => {
  await assert.rejects(
    resolvePublicAddresses({
      hostname: "jobs.example.com",
      signal: new AbortController().signal,
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      publicAddress,
      abortMessage: "Posting lookup timed out",
      removeAbortListener: false,
      unsafeAddressError: () =>
        new Error(
          "The posting host resolves to a private or unsupported address",
        ),
    }),
    /private or unsupported/,
  );
  assert.throws(() => postingUrl("http://127.0.0.1/jobs"), /private|Local/);
});
