import { canonicalPostingUrl } from "../shared/posting-url.js";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { load } from "cheerio";
import {
  decodeGuardedResponse,
  guardedRequest,
  resolvePublicAddresses,
  type GuardedAddress,
} from "./guarded-http.js";
import { HttpError, sha256, now } from "./storage.js";

const blocked = new BlockList();
// Each entry is a network/prefix-length tuple for BlockList.addSubnet.
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as [string, number][])
  blocked.addSubnet(network, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
// Preserve the network/prefix tuple types expected by the subnet loop.
for (const [network, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as [string, number][])
  blocked.addSubnet(network, bits, "ipv6");
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function postingUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Enter a complete public HTTP(S) posting URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > 3000 ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new HttpError(
      400,
      "Only public HTTP(S) posting URLs on standard web ports are supported",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    /(^|\.)(localhost|local|internal)$/.test(hostname) ||
    (isIP(hostname) && !publicAddress(hostname))
  )
    throw new HttpError(
      400,
      "Local, private and special-use network addresses are not allowed",
    );
  url.hash = "";
  return url;
}
const limit = 2 * 1024 * 1024;
export function canonicalPosting(value: string) {
  // Validates the URL, then applies the shared canonicalizer: tracking parameters
  // are irrelevant, but requisition query parameters are identities.
  return canonicalPostingUrl(postingUrl(value).href);
}
export function samePostingUrls(a: string, b: string) {
  try {
    return canonicalPosting(a) === canonicalPosting(b);
  } catch {
    return false;
  }
}
type Address = GuardedAddress;
type Page = {
  status: number;
  location?: string;
  type: string;
  body: Buffer;
  encoding?: string;
};
async function readPage(
  url: URL,
  address: Address,
  signal: AbortSignal,
): Promise<Page> {
  const page = await guardedRequest({
    url,
    address,
    signal,
    agent: false,
    method: "GET",
    headers: {
      "User-Agent": "Fieldwork/1.0 (personal job-posting reader)",
      Accept: "text/html,text/plain,application/json",
      "Accept-Encoding": "identity",
    },
    endPayload: "omit",
    lookupPolicy: "honor-all",
    requestOptionOrder: "headers-lookup",
    responseDefaults: "nullish",
    maxBytes: limit,
    overflowMessage: "Posting response exceeded 2 MB",
    overflowTarget: "response",
  });
  return {
    status: page.status,
    location: page.location,
    type: page.type,
    encoding: page.encoding,
    body: page.bytes,
  };
}
export function postingText(
  html: string,
  type = "text/html",
): { title: string; text: string } {
  if (/text\/plain/.test(type))
    return { title: "Job posting", text: html.trim() };
  if (/application\/json/.test(type)) {
    const item = JSON.parse(html);
    const candidate = item.description ?? item.content;
    if (typeof candidate !== "string")
      throw new Error("No posting description found in JSON");
    return {
      title: String(item.title ?? item.name ?? "Job posting"),
      text: postingText(candidate).text,
    };
  }
  const $ = load(html);
  let job: any;
  function visit(value: any) {
    if (!value || typeof value !== "object") return;
    if (
      value["@type"] === "JobPosting" ||
      (Array.isArray(value["@type"]) && value["@type"].includes("JobPosting"))
    )
      job ??= value;
    if (Array.isArray(value)) value.forEach(visit);
    else if (value["@graph"]) visit(value["@graph"]);
  }
  $('script[type="application/ld+json"]').each((_i, e) => {
    try {
      visit(JSON.parse($(e).text()));
    } catch {}
  });
  const title = String(
    job?.title ?? $("title").first().text() ?? "Job posting",
  ).trim();
  $("script,style,noscript,nav,header,footer,form,iframe,svg").remove();
  $("p,li,h1,h2,h3,h4,br,section,div").each((_i, e) => {
    $(e).prepend("\n");
  });
  let text = (
    $("main").first().length
      ? $("main").first().text()
      : $("article").first().length
        ? $("article").first().text()
        : $("body").text()
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  if (job?.description) {
    const details = load(job.description);
    details("script,style,iframe").remove();
    details("p,li,br").prepend("\n");
    text = `${title}\nEmployer: ${job.hiringOrganization?.name ?? "not specified"}\nLocation: ${JSON.stringify(job.jobLocation ?? job.applicantLocationRequirements ?? "not specified")}\nSalary as published: ${JSON.stringify(job.baseSalary ?? "not specified")}\n\n${details.text()}\n\nOther visible posting details:\n${text}`;
  }
  if (
    !job &&
    /access denied|verify you are human|checking your browser|captcha|enable javascript/i.test(
      text,
    ) &&
    text.length < 1500
  )
    throw new Error("The site requires browser verification or JavaScript");
  return { title, text };
}
export async function fetchPosting(
  value: string,
  deps: {
    resolve?: (name: string) => Promise<Address[]>;
    read?: (url: URL, address: Address, signal: AbortSignal) => Promise<Page>;
  } = {},
) {
  let url = postingUrl(value);
  const original = url.href;
  const signal = AbortSignal.timeout(15000);
  const resolver =
    deps.resolve ??
    (async (host: string) => lookup(host, { all: true, verbatim: true }));
  try {
    for (let redirect = 0; redirect < 5; redirect++) {
      signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await resolvePublicAddresses({
        hostname: host,
        signal,
        resolve: resolver,
        publicAddress,
        abortMessage: "Posting lookup timed out",
        removeAbortListener: false,
        unsafeAddressError: () =>
          new HttpError(
            400,
            "The posting host resolves to a private or unsupported address",
          ),
      });
      const page = await (deps.read ?? readPage)(url, addresses[0], signal);
      if ([301, 302, 303, 307, 308].includes(page.status)) {
        if (!page.location)
          throw new Error("Posting redirect has no destination");
        url = postingUrl(new URL(page.location, url).href);
        continue;
      }
      if (page.status < 200 || page.status >= 300)
        throw new Error(`The site returned HTTP ${page.status}`);
      if (
        !/text\/(?:html|plain)|application\/(?:xhtml\+xml|json)/i.test(
          page.type,
        )
      )
        throw new Error("This URL is not a readable HTML or text posting");
      const bytes = decodeGuardedResponse(page.body, page.encoding, {
        maxOutputLength: limit,
        unsupportedEncodingMessage: "Unsupported response encoding",
      });
      const parsed = postingText(bytes.toString("utf8"), page.type);
      if (parsed.text.length < 100)
        throw new Error("No usable posting text was returned");
      const truncated = parsed.text.length > 60000;
      const text = parsed.text.slice(0, 60000);
      return {
        kind: "url",
        url: original,
        finalUrl: url.href,
        title: parsed.title,
        text,
        hash: sha256(text),
        fetchedAt: now(),
        truncated,
      };
    }
    throw new Error("Too many posting redirects");
  } catch (error: any) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      422,
      `Could not read this posting: ${error.message}. Paste the job description instead.`,
    );
  }
}
