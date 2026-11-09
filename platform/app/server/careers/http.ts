import { tunableValue, type TunableSettings } from "../../shared/tunables.js";
/** Public, read-only careers retrieval. Every connection pins a vetted DNS address. */
import { lookup } from "node:dns/promises";
import {
  decodeGuardedResponse,
  guardedRequest,
  resolvePublicAddresses,
} from "../guarded-http.js";
import { postingUrl, publicAddress } from "../job-posting.js";
export type CareersResponse = {
  url: string;
  requestedUrl: string;
  status: number;
  type: string;
  text: string;
  at: string;
  retryAfter?: string;
  redirects?: string[];
  browserSettled?: boolean;
  browserBlockedEssential?: number;
};
export type CareersFetch = (
  url: string,
  body?: {
    limit: number;
    offset: number;
    searchText: string;
    appliedFacets: Record<string, never>;
  },
) => Promise<CareersResponse>;
function validateRequest(url: URL, body: Parameters<CareersFetch>[1]) {
  if (
    body &&
    (!/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i.test(url.hostname) ||
      !/^\/wday\/cxs\/[^/]+\/[^/]+\/jobs$/.test(url.pathname) ||
      body.limit !== 20 ||
      !Number.isInteger(body.offset) ||
      body.offset < 0 ||
      body.searchText !== "" ||
      Object.keys(body.appliedFacets).length)
  )
    throw Error("Only the read-only Workday search POST is allowed");
}
export async function publicCareersFetch(
  value: string,
  signal: AbortSignal,
  body?: Parameters<CareersFetch>[1],
  settings: () => TunableSettings = () => ({}),
): Promise<CareersResponse> {
  let url = postingUrl(value);
  const redirects: string[] = [];
  const timeout = AbortSignal.any([
    signal,
    AbortSignal.timeout(
      tunableValue(settings(), "careers.httpTimeoutS") * 1000,
    ),
  ]);
  const limit =
    tunableValue(settings(), "careers.responseLimitMiB") * 1024 * 1024;
  for (let i = 0; i < 6; i++) {
    timeout.throwIfAborted();
    validateRequest(url, body);
    const addresses = await resolvePublicAddresses({
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      signal: timeout,
      resolve: (hostname) => lookup(hostname, { all: true }),
      publicAddress,
      abortMessage: "Careers lookup cancelled or timed out",
      removeAbortListener: true,
      unsafeAddressError: () =>
        Error("Careers URL resolves to a private or unsupported address"),
    });
    const pinned = addresses[0];
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const page = await guardedRequest({
      url,
      address: pinned,
      signal: timeout,
      agent: false,
      method: body ? "POST" : "GET",
      lookupPolicy: "always-array",
      requestOptionOrder: "lookup-headers",
      headers: {
        "User-Agent": "Fieldwork/1.0 (personal careers research)",
        Accept: "application/json,text/html,text/plain",
        "Accept-Encoding": "identity",
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(payload.length),
            }
          : {}),
      },
      payload,
      endPayload: "pass",
      responseDefaults: "falsy",
      maxBytes: limit,
      overflowMessage: `Careers response exceeds ${limit / 1024 / 1024} MB`,
      overflowTarget: "request",
    });
    if ([301, 302, 303, 307, 308].includes(page.status)) {
      if (body)
        throw Error(
          "Workday search redirected; its board requires revalidation",
        );
      if (!page.location) throw Error("Redirect has no destination");
      url = postingUrl(new URL(page.location, url).href);
      redirects.push(url.href);
      continue;
    }
    const bytes = decodeGuardedResponse(page.bytes, page.encoding, {
      maxOutputLength: limit,
      unsupportedEncodingMessage: "Unsupported careers response encoding",
    });
    if (!/text\/(html|plain)|application\/(json|xhtml\+xml)/i.test(page.type))
      throw Error("Career endpoint did not return readable HTML/JSON");
    return {
      url: url.href,
      requestedUrl: value,
      ...(redirects.length ? { redirects } : {}),
      status: page.status,
      retryAfter: page.retryAfter,
      type: page.type,
      text: bytes.toString("utf8"),
      at: new Date().toISOString(),
    };
  }
  throw Error("Too many career redirects");
}
