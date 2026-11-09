import http, {
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type RequestOptions,
} from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export type GuardedAddress = { address: string; family: number };
export type GuardedResponse = {
  status: number;
  location?: string;
  type: string;
  encoding?: string;
  retryAfter?: string;
  bytes: Buffer;
};

type GuardedResponseStream = {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  on(event: "data", listener: (chunk: Buffer) => void): GuardedResponseStream;
  on(event: "error", listener: (error: Error) => void): GuardedResponseStream;
  on(event: "end", listener: () => void): GuardedResponseStream;
  destroy(error?: Error): GuardedResponseStream;
};
type GuardedRequestStream = {
  on(event: "error", listener: (error: Error) => void): GuardedRequestStream;
  end(data?: Buffer): GuardedRequestStream;
  destroy(error?: Error): GuardedRequestStream;
};
export type GuardedTransport = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: GuardedResponseStream) => void,
) => GuardedRequestStream;

export async function resolvePublicAddresses(options: {
  hostname: string;
  signal: AbortSignal;
  resolve: (hostname: string) => Promise<GuardedAddress[]>;
  publicAddress: (address: string) => boolean;
  abortMessage: string;
  removeAbortListener: boolean;
  unsafeAddressError: () => Error;
}): Promise<GuardedAddress[]> {
  // Preserve the unbound invocation of fetchPosting's injected resolver.
  const { resolve } = options;
  let abort = () => {};
  let addresses: GuardedAddress[];
  try {
    addresses = await Promise.race([
      resolve(options.hostname),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error(options.abortMessage));
        options.signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (options.removeAbortListener)
      options.signal.removeEventListener("abort", abort);
  }
  if (
    !addresses.length ||
    addresses.some((address) => !options.publicAddress(address.address))
  )
    throw options.unsafeAddressError();
  return addresses;
}

export function pinnedLookup(
  address: GuardedAddress,
  policy: "honor-all" | "always-array",
): LookupFunction {
  return (_hostname, options, callback) => {
    if (policy === "honor-all" && !options?.all)
      callback(null, address.address, address.family);
    else callback(null, [address]);
  };
}

function defaultTransport(
  url: URL,
  options: RequestOptions,
  onResponse: (response: GuardedResponseStream) => void,
): GuardedRequestStream {
  return (url.protocol === "https:" ? https : http).request(
    url,
    options,
    onResponse,
  );
}

export async function guardedRequest(options: {
  url: URL;
  address: GuardedAddress;
  signal: AbortSignal;
  agent: false;
  method: "GET" | "POST";
  headers: OutgoingHttpHeaders;
  payload?: Buffer;
  endPayload: "omit" | "pass";
  lookupPolicy: "honor-all" | "always-array";
  requestOptionOrder: "headers-lookup" | "lookup-headers";
  responseDefaults: "nullish" | "falsy";
  maxBytes: number;
  overflowMessage: string;
  overflowTarget: "response" | "request";
  transport?: GuardedTransport;
}): Promise<GuardedResponse> {
  return new Promise((resolve, reject) => {
    const lookup = pinnedLookup(options.address, options.lookupPolicy);
    const requestOptions =
      options.requestOptionOrder === "headers-lookup"
        ? {
            method: options.method,
            signal: options.signal,
            agent: options.agent,
            headers: options.headers,
            lookup,
          }
        : {
            method: options.method,
            signal: options.signal,
            agent: options.agent,
            lookup,
            headers: options.headers,
          };
    let request: GuardedRequestStream;
    request = (options.transport ?? defaultTransport)(
      options.url,
      requestOptions,
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > options.maxBytes) {
            const error = new Error(options.overflowMessage);
            if (options.overflowTarget === "response") response.destroy(error);
            else request.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const fallback = options.responseDefaults === "nullish";
          resolve({
            status: fallback
              ? (response.statusCode ?? 0)
              : response.statusCode || 0,
            location: response.headers.location,
            type: fallback
              ? (response.headers["content-type"] ?? "")
              : response.headers["content-type"] || "",
            encoding: response.headers["content-encoding"],
            retryAfter: response.headers["retry-after"],
            bytes: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.endPayload === "pass") request.end(options.payload);
    else request.end();
  });
}

export function decodeGuardedResponse(
  bytes: Buffer,
  encoding: string | undefined,
  options: { maxOutputLength: number; unsupportedEncodingMessage: string },
): Buffer {
  const limit = { maxOutputLength: options.maxOutputLength };
  if (encoding === "gzip") return gunzipSync(bytes, limit);
  if (encoding === "br") return brotliDecompressSync(bytes, limit);
  if (encoding === "deflate") return inflateSync(bytes, limit);
  if (encoding && encoding !== "identity")
    throw new Error(options.unsupportedEncodingMessage);
  return bytes;
}
