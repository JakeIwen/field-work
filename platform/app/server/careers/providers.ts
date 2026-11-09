import { tunableValue, type TunableSettings } from "../../shared/tunables.js";
import { load } from "cheerio";
import { salaryLines } from "../pay-text.js";
export { salaryLines } from "../pay-text.js";
import { htmlText } from "../importer.js";
import { sha256 } from "../storage.js";
import { postingUrl } from "../job-posting.js";
import type { CareersFetch, CareersResponse } from "./http.js";
import {
  canonicalPostingUrl,
  retiredJobBoard,
} from "../../shared/posting-url.js";
import {
  defaultFitCriteria,
  type FitCriteria,
} from "../../shared/fit-criteria.js";
import { compileFitCriteria, excludedTechnology } from "../fit-criteria.js";
import { errorMessage } from "../import/read-context.js";
import type { Company, Opening } from "../../shared/types.js";
import {
  payloadValue,
  readCareersProviderFeed,
  readOptionalGreenhouseJobDetail,
  readOptionalWorkdayPostingDetail,
  readStructuredJobPostings,
  readWorkdayInventory,
  readWorkdayPostingDetail,
  type GreenhouseJobPayload,
  type StructuredJobPostingPayload,
  type WorkdayJobPayload,
} from "./provider-payloads.js";
import type { ScanJob, CompanyScan } from "./model.js";
export type { ScanJob, CompanyScan } from "./model.js";
const text = (s: unknown) => {
  let value = String(s ?? "");
  if (/&lt;(?:p|div|ul|li|br|h[1-6])(?:&gt;|[ ;])/i.test(value))
    value = load("<body>" + value + "</body>")("body").text();
  return htmlText(value).trim();
};
const plain = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const emptyBoard =
  /\b(?:no (?:current |open |available )?(?:job openings|openings|positions|vacancies)|not currently hiring|aren['’]t currently hiring|we (?:don['’]t|do not) have any (?:job )?(?:openings|positions))\b/i;
// Shared with URL imports and opening overlays; see shared/posting-url.ts.
export const canonicalUrl = (s: string) => canonicalPostingUrl(s);
export const engineeringTitle = (s: string) =>
  /engineer|developer/i.test(s) &&
  !/manager|director|principal|intern|graduate|junior|sales|support|solutions|salesforce|firmware|hardware|electrical|mechanical|test automation|quality assurance|\bQA\b/i.test(
    s,
  );
// Rules that are not user criteria stay fixed: talent-community/general
// applications, unlisted jobs, the engineer/developer requirement, US state
// codes, the feed's remote flag and the foreign-country exclusion.
const generalApplication =
  /talent (?:community|pool|network)|general application|expression of interest|future opportunit|register.*interest|open application/i;
const usStateCode = /\b(?:WA|CA|NY|TX|IL|MA|CO|GA|NC|VA|PA|FL|AZ|UT|OR|DC)\b/;
const foreignLocation =
  /\b(?:Canada|United Kingdom|UK|Germany|India|Poland|Brazil|Mexico|Australia|Ireland|Netherlands|Spain|France|EMEA|APAC|Europe)\b/i;
export function candidate(
  j: ScanJob,
  criteria: FitCriteria = defaultFitCriteria,
) {
  const c = compileFitCriteria(criteria);
  const title = j.title,
    loc = j.location,
    body = j.description;
  if (excludedTechnology(`${title}\n${body}`, criteria)) return false;
  if (generalApplication.test(title)) return false;
  if (
    j.listed === false ||
    !/engineer|developer/i.test(title) ||
    c.roleExclude?.test(title) ||
    (c.seniority && !c.seniority.test(title))
  )
    return false;
  if (c.locationExclude?.test(loc) || c.locationSentence?.test(body))
    return false;
  const us =
    !!c.usLocation?.test(loc) ||
    usStateCode.test(loc) ||
    c.bareLocation.test(loc.trim());
  if (!us) return false;
  if (
    (c.titleRequire && !c.titleRequire.test(title)) ||
    c.titleExclude?.test(title)
  )
    return false;
  if (c.bodyRequire && !c.bodyRequire.test(body)) return false;
  if (!us && foreignLocation.test(loc)) return false;
  return (
    j.remote === true ||
    !!c.remoteLocation?.test(loc) ||
    !!c.remoteBody?.test(body)
  );
}
export function jobFingerprint(j: ScanJob) {
  return sha256(
    JSON.stringify([
      plain(j.title),
      plain(j.location),
      plain(j.description),
      plain(j.salary),
      j.remote ?? null,
      j.deadline ?? null,
    ]),
  );
}
export function boardEndpoint(
  value: string,
): { kind: "greenhouse" | "workday"; url: string } | null {
  let u: URL;
  try {
    u = postingUrl(value);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (
    [
      "job-boards.greenhouse.io",
      "boards.greenhouse.io",
      "boards-api.greenhouse.io",
    ].includes(u.hostname)
  ) {
    const token =
      u.hostname === "boards-api.greenhouse.io"
        ? parts[2]
        : u.searchParams.get("for") || parts[0];
    if (token && /^[\w-]+$/.test(token) && token !== "embed")
      return {
        kind: "greenhouse",
        url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
      };
  }
  if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i.test(u.hostname)) {
    if (
      parts[0] === "wday" &&
      parts[1] === "cxs" &&
      parts.length === 5 &&
      parts[4] === "jobs"
    )
      return { kind: "workday", url: u.origin + u.pathname };
    const board = parts[0]?.match(/^[a-z]{2}-[A-Z]{2}$/) ? parts[1] : parts[0];
    if (board && /^[\w-]+$/.test(board))
      return {
        kind: "workday",
        url: `${u.origin}/wday/cxs/${u.hostname.split(".")[0]}/${board}/jobs`,
      };
  }
  return null;
}
function json(p: CareersResponse): unknown {
  if (p.status !== 200) throw Error(`Career feed returned HTTP ${p.status}`);
  try {
    const value: unknown = JSON.parse(p.text);
    return value;
  } catch {
    throw Error("Career feed returned invalid JSON");
  }
}
type ScanJobInput = Omit<ScanJob, "id" | "title" | "location" | "listed"> & {
  id: unknown;
  title: unknown;
  location: unknown;
  listed?: unknown;
};
function valid(j: ScanJobInput): ScanJob;
function valid(j: ScanJobInput) {
  if (
    !j.id ||
    !j.title ||
    !j.url ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,180}$/.test(String(j.id))
  )
    throw Error("Incomplete requisition in career inventory");
  j.url = postingUrl(j.url).href;
  if (retiredJobBoard(j.url))
    throw Error("Ashby/Lever integrations are retired");
  return j;
}
export type CareersCompany = Pick<Company, "id" | "name"> & {
  fields?: Record<string, string>;
};
export type PriorCompanyScan = Pick<CompanyScan, "sources"> | null | undefined;
export type RetainedCareerOpening = Pick<Opening, "job_id" | "title" | "url">;
type BrowserFetch = ((url: string) => Promise<CareersResponse>) | undefined;
type SupportedBoard = NonNullable<ReturnType<typeof boardEndpoint>>;

function normalizeGreenhouseJob(
  r: GreenhouseJobPayload,
  source: string,
  at: string,
) {
  const description = text(r.content);
  return valid({
    id: String(r.id ?? ""),
    title: plain(r.title),
    url: String(r.absoluteUrl ?? ""),
    location: plain(r.locationName),
    description,
    salary: salaryLines(description),
    listed: r.internalJobId !== null,
    source,
    at,
    detailVerified: !!description,
  });
}

export function normalizeFeed(
  kind: string,
  data: unknown,
  source: string,
  at: string,
): ScanJob[] {
  const feed = readCareersProviderFeed(kind, data);
  const jobs = feed.rows.map((row) => normalizeGreenhouseJob(row, source, at));
  if (new Set(jobs.map((j) => j.id)).size !== jobs.length)
    throw Error("Duplicate requisitions make this inventory incomplete");
  return jobs;
}
function explicitlyClosed(page: CareersResponse) {
  return (
    page.status === 200 &&
    /\b(?:this (?:job|position|role) (?:is |has been )?(?:no longer available|closed|filled)|(?:job|position) (?:has been closed|is no longer posted)|no longer accepting applications(?:[.!]|\s*(?:\n|$)))/i.test(
      text(page.text),
    )
  );
}
export function htmlJobs(page: CareersResponse): StructuredJobPostingPayload[] {
  if (explicitlyClosed(page)) return [];
  const $ = load(page.text);
  const jobs: StructuredJobPostingPayload[] = [];
  $('script[type="application/ld+json"]').each((_i, e) => {
    try {
      const value: unknown = JSON.parse($(e).text());
      jobs.push(...readStructuredJobPostings(value));
    } catch {}
  });
  return jobs;
}
function customJob(
  j: StructuredJobPostingPayload,
  page: CareersResponse,
  known?: RetainedCareerOpening,
): ScanJob {
  const identifierValue = j.identifier
    ? payloadValue(j.identifier, "value", "structured job identifier")
    : undefined;
  const id =
    known?.job_id ||
    String(
      identifierValue ||
        (typeof j.identifier === "string" ? j.identifier : "") ||
        "",
    ) ||
    `url-${sha256(canonicalUrl(String(j.url || page.url))).slice(0, 20)}`;
  const description = text(j.description);
  const validThrough = String(j.validThrough || "");
  return valid({
    id,
    title: plain(j.title || known?.title),
    url: j.url ? new URL(String(j.url), page.url).href : page.url,
    location: [
      j.jobLocationType,
      j.applicantLocationRequirements
        ? JSON.stringify(j.applicantLocationRequirements)
        : "",
      j.jobLocation ? JSON.stringify(j.jobLocation) : "",
    ]
      .filter(Boolean)
      .join("; "),
    description,
    salary: [
      j.baseSalary ? JSON.stringify(j.baseSalary) : "",
      salaryLines(description),
    ]
      .filter(Boolean)
      .join(" "),
    remote: j.jobLocationType === "TELECOMMUTE",
    deadline: /^\d{4}-\d{2}-\d{2}/.test(validThrough)
      ? validThrough.slice(0, 10)
      : null,
    source: page.requestedUrl,
    at: page.at,
    detailVerified: !!description,
  });
}
type ScannedCompany = CareersCompany;
type RetainedOpenings = RetainedCareerOpening[];
type RetainedOpening = RetainedOpenings[number];

async function loadLanding(
  career: string,
  get: CareersFetch,
  signal: AbortSignal,
  notes: string[],
) {
  let landing: CareersResponse | undefined;
  const links: string[] = [];
  try {
    landing = await get(career);
    if (landing.status !== 200)
      notes.push(`Landing page HTTP ${landing.status}`);
    else {
      const $ = load(landing.text);
      $("[href],[src]").each((_i, e) => {
        const v = $(e).attr("href") || $(e).attr("src");
        if (v)
          try {
            links.push(new URL(v, landing!.url).href);
          } catch {}
      });
    }
  } catch (e) {
    if (signal.aborted) throw e;
    notes.push(`Landing page: ${errorMessage(e)}`);
  }
  return { landing, links };
}

function discoverBoards(
  career: string,
  links: string[],
  prior: PriorCompanyScan,
) {
  const seeds =
    canonicalUrl(prior?.sources?.[0] || "") === canonicalUrl(career)
      ? prior?.sources || []
      : [];
  return [
    ...new Map(
      [career, ...links, ...seeds]
        .map(boardEndpoint)
        .filter(Boolean)
        .map((b) => [b!.url, b!]),
    ).values(),
  ].slice(0, 3);
}

function appendWorkdayPageJobs(
  jobs: ScanJob[],
  seen: Set<unknown>,
  rows: WorkdayJobPayload[],
  board: SupportedBoard,
  response: CareersResponse,
  retained: RetainedOpenings,
) {
  for (const r of rows) {
    if (typeof r.externalPath !== "string" || !r.title)
      throw Error("Incomplete Workday requisition");
    const origin = new URL(board.url).origin,
      site = new URL(board.url).pathname.split("/")[4],
      url = origin + "/" + site + r.externalPath;
    const previous = retained.find(
      (o) => canonicalUrl(o.url) === canonicalUrl(url),
    );
    const bulletId = r.bulletFields.find((v) =>
      /^[A-Z]{1,5}\d[\w-]*$/i.test(String(v)),
    );
    const id =
      previous?.job_id || bulletId || r.externalPath.split("_").at(-1) || "";
    if (seen.has(id)) throw Error("Workday pagination repeated requisitions");
    seen.add(id);
    jobs.push(
      valid({
        id,
        title: r.title,
        url,
        location: r.locationsText || "",
        description: "",
        salary: "",
        source: board.url,
        at: response.at,
        detailUrl: board.url.replace(/\/jobs$/, "") + r.externalPath,
      }),
    );
  }
}

function workdayDeadline(value: unknown) {
  const candidate = value || "";
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(candidate))) return null;
  return Array.isArray(candidate)
    ? candidate.slice(0, 10)
    : String(candidate).slice(0, 10);
}

/** Per-company limits, read once when a company's scan starts so one scan never
 * mixes two values of the same setting. */
type ScanLimits = { workdayDescriptions: number; customPostings: number };
function scanLimits(settings: TunableSettings): ScanLimits {
  return {
    workdayDescriptions: tunableValue(settings, "careers.workdayDescriptions"),
    customPostings: tunableValue(settings, "careers.customPostings"),
  };
}

async function hydrateWorkdayDescriptions(
  jobs: ScanJob[],
  retained: RetainedOpenings,
  get: CareersFetch,
  signal: AbortSignal,
  notes: string[],
  limits: ScanLimits,
) {
  const details = jobs.filter(
    (j) =>
      retained.some((o) => o.job_id === j.id) ||
      (engineeringTitle(j.title) &&
        /senior|\bsr\b|lead|III|IV|full.?stack/i.test(j.title)),
  );
  if (details.length > limits.workdayDescriptions)
    notes.push(
      `More than ${limits.workdayDescriptions} relevant Workday descriptions; remaining roles need review`,
    );
  for (const j of details.slice(0, limits.workdayDescriptions)) {
    try {
      const p = await get(j.detailUrl!),
        d = readWorkdayPostingDetail(json(p));
      Object.assign(j, { id: d.jobReqId });
      j.description = text(d.jobDescription);
      j.salary = salaryLines(j.description);
      j.location =
        [d.location, ...d.additionalLocations].filter(Boolean).join("; ") ||
        j.location;
      Object.assign(j, { deadline: workdayDeadline(d.endDate) });
      j.detailVerified = true;
      j.at = p.at;
    } catch (e) {
      if (signal.aborted) throw e;
      notes.push(`Detail ${j.id}: ${errorMessage(e)}`);
    }
  }
}

async function fetchWorkdayInventory(
  board: SupportedBoard,
  retained: RetainedOpenings,
  get: CareersFetch,
  signal: AbortSignal,
  notes: string[],
  limits: ScanLimits,
) {
  const jobs: ScanJob[] = [];
  let total: number | undefined;
  const seen = new Set<unknown>();
  for (let offset = 0; offset < 10000; offset += 20) {
    const p = await get(board.url, {
        limit: 20,
        offset,
        searchText: "",
        appliedFacets: {},
      }),
      data = readWorkdayInventory(json(p));
    if (total !== undefined && data.total !== 0 && total !== data.total)
      throw Error("Workday inventory changed during pagination");
    if (total === undefined) total = data.total;
    appendWorkdayPageJobs(jobs, seen, data.jobPostings, board, p, retained);
    if (jobs.length === total) break;
    if (!data.jobPostings.length || jobs.length > total!)
      throw Error("Workday pagination is incomplete");
  }
  if (jobs.length !== total)
    throw Error("Workday inventory exceeded the bounded page limit");
  const verify = readWorkdayInventory(
    json(
      await get(board.url, {
        limit: 20,
        offset: 0,
        searchText: "",
        appliedFacets: {},
      }),
    ),
  );
  if (
    verify.total !== total ||
    JSON.stringify(verify.jobPostings.map((j) => j.externalPath)) !==
      JSON.stringify(
        jobs
          .slice(0, 20)
          .map((j) =>
            new URL(j.detailUrl!).pathname.replace(
              new URL(board.url).pathname.replace(/\/jobs$/, ""),
              "",
            ),
          ),
      )
  )
    throw Error(
      "Workday first-page verification changed; inventory is not stable",
    );
  await hydrateWorkdayDescriptions(jobs, retained, get, signal, notes, limits);
  return jobs;
}

async function collectSupportedBoards(
  boards: SupportedBoard[],
  retained: RetainedOpenings,
  get: CareersFetch,
  signal: AbortSignal,
  result: CompanyScan,
  notes: string[],
  limits: ScanLimits,
) {
  for (const board of boards) {
    try {
      let jobs: ScanJob[];
      if (board.kind === "workday")
        jobs = await fetchWorkdayInventory(
          board,
          retained,
          get,
          signal,
          notes,
          limits,
        );
      else {
        const p = await get(board.url);
        jobs = normalizeFeed(board.kind, json(p), board.url, p.at);
      }
      if (new Set(jobs.map((j) => j.id)).size !== jobs.length)
        throw Error("Duplicate canonical requisitions");
      result.jobs = jobs;
      result.complete = true;
      result.inventory_count = jobs.length;
      result.result = notes.some((n) => /^Detail |^More than/.test(n))
        ? "PARTIAL"
        : "SUCCESS";
      return board;
    } catch (e) {
      if (signal.aborted) throw e;
      notes.push(`${board.kind}: ${errorMessage(e)}`);
    }
  }
}

async function tryBrowserFallback(
  company: ScannedCompany,
  prior: PriorCompanyScan,
  retained: RetainedOpenings,
  fetch: CareersFetch,
  signal: AbortSignal,
  browser: BrowserFetch,
  career: string,
  landing: CareersResponse | undefined,
  result: CompanyScan,
  notes: string[],
  options: CollectOptions,
): Promise<CompanyScan | undefined> {
  if (
    result.complete ||
    retiredJobBoard(career) ||
    !browser ||
    signal.aborted ||
    (landing?.status === 200 && emptyBoard.test(text(landing.text)))
  )
    return;
  try {
    const rendered = await browser(career);
    signal.throwIfAborted();
    if (rendered.status === 200) {
      const next = await collectCompany(
        company,
        prior,
        retained,
        (url, body) =>
          url === career && !body
            ? Promise.resolve(rendered)
            : fetch(url, body),
        signal,
        undefined,
        options,
      );
      next.notes =
        "Rendered career page checked through browser_clean. " + next.notes;
      return next;
    }
  } catch (e) {
    if (signal.aborted) throw e;
    notes.push("Browser fallback: " + errorMessage(e));
  }
}

function discoverCustomCandidates(
  $: ReturnType<typeof load>,
  landing: CareersResponse,
) {
  const candidates = new Map<string, string>();
  $("a[href]").each((_i, e) => {
    const title = plain($(e).text());
    if (
      engineeringTitle(title) &&
      /senior|\bsr\b|lead|full.?stack/i.test(title)
    )
      try {
        const u = new URL($(e).attr("href")!, landing.url);
        if (/jobs?|careers?|journey|position|opening/i.test(u.href))
          candidates.set(u.href, title);
      } catch {}
  });
  return candidates;
}

async function fetchCustomCandidates(
  candidates: Map<string, string>,
  retained: RetainedOpenings,
  get: CareersFetch,
  signal: AbortSignal,
  result: CompanyScan,
  notes: string[],
  limits: ScanLimits,
) {
  for (const [url, title] of [...candidates].slice(0, limits.customPostings)) {
    try {
      const p = await get(url);
      if (p.status === 200) {
        for (const j of htmlJobs(p))
          result.jobs.push(
            customJob(
              j,
              p,
              retained.find((o) => canonicalUrl(o.url) === canonicalUrl(url)),
            ),
          );
      }
    } catch (e) {
      if (signal.aborted) throw e;
      notes.push(`Linked posting: ${errorMessage(e)}`);
    }
  }
}

async function collectCustomInventory(
  landing: CareersResponse | undefined,
  retained: RetainedOpenings,
  get: CareersFetch,
  signal: AbortSignal,
  result: CompanyScan,
  notes: string[],
  limits: ScanLimits,
) {
  if (result.complete || landing?.status !== 200) return;
  const $ = load(landing.text);
  for (const j of htmlJobs(landing)) {
    try {
      result.jobs.push(customJob(j, landing));
    } catch {}
  }
  const candidates = discoverCustomCandidates($, landing);
  await fetchCustomCandidates(
    candidates,
    retained,
    get,
    signal,
    result,
    notes,
    limits,
  );
  const mainText = text($("main").length ? $("main").html() : $("body").html());
  if (
    !result.jobs.length &&
    !candidates.size &&
    landing.browserSettled !== false &&
    !landing.browserBlockedEssential &&
    emptyBoard.test(mainText) &&
    !/access denied|captcha|enable javascript|verify you are human/i.test(
      mainText,
    )
  ) {
    result.complete = true;
    result.inventory_count = 0;
    result.result = "SUCCESS";
    notes.push("Careers page explicitly reports no openings.");
  } else {
    result.result = "PARTIAL";
    notes.push(
      "No complete supported inventory was established; custom/JavaScript boards may need manual research.",
    );
  }
}

function retainedApiUrl(completeBoard: SupportedBoard, old: RetainedOpening) {
  let detailUrl: string | undefined;
  if (completeBoard.kind === "greenhouse" && /^\d+$/.test(old.job_id))
    detailUrl =
      completeBoard.url.split("?")[0] + "/" + old.job_id + "?content=true";
  if (completeBoard.kind === "workday") {
    const jobPath = new URL(old.url).pathname;
    if (jobPath.includes("/job/"))
      detailUrl =
        completeBoard.url.replace(/\/jobs$/, "") +
        jobPath.slice(jobPath.indexOf("/job/"));
  }
  return detailUrl;
}

function normalizeDirectApiJob(
  completeBoard: SupportedBoard,
  old: RetainedOpening,
  detailUrl: string,
  detail: CareersResponse,
) {
  const raw: unknown = JSON.parse(detail.text);
  let directJob: ScanJob | undefined;
  const greenhouse = readOptionalGreenhouseJobDetail(raw);
  if (
    completeBoard.kind === "greenhouse" &&
    greenhouse &&
    String(greenhouse.id) === old.job_id
  )
    directJob = normalizeGreenhouseJob(greenhouse, detailUrl, detail.at);
  const d = readOptionalWorkdayPostingDetail(raw);
  if (
    completeBoard.kind === "workday" &&
    d?.jobReqId === old.job_id &&
    d.jobDescription
  )
    directJob = {
      id: d.jobReqId,
      title: typeof d.title === "string" && d.title ? d.title : old.title,
      url: old.url,
      location: [d.location, ...d.additionalLocations]
        .filter(Boolean)
        .join("; "),
      description: text(d.jobDescription),
      salary: salaryLines(text(d.jobDescription)),
      source: detailUrl,
      at: detail.at,
      detailVerified: true,
    };
  return directJob;
}

async function checkRetainedApi(
  result: CompanyScan,
  old: RetainedOpening,
  completeBoard: SupportedBoard,
  detailUrl: string,
  get: CareersFetch,
  signal: AbortSignal,
  notes: string[],
) {
  try {
    const detail = await get(detailUrl);
    if ([404, 410].includes(detail.status)) {
      result.direct[old.job_id] = {
        status: "closed",
        reason: `Official posting API HTTP ${detail.status}; absent from the complete current inventory`,
        at: detail.at,
      };
      return true;
    }
    if (detail.status === 200) {
      const directJob = normalizeDirectApiJob(
        completeBoard,
        old,
        detailUrl,
        detail,
      );
      if (directJob?.detailVerified) {
        result.jobs.push(directJob);
        result.direct[old.job_id] = {
          status: "open",
          reason: "Matching requisition confirmed by its official posting API",
          at: detail.at,
          job: directJob,
        };
        return true;
      }
    }
  } catch (e) {
    if (signal.aborted) throw e;
    notes.push(`Direct API ${old.job_id}: ${errorMessage(e)}`);
  }
  return false;
}

async function checkRetainedPage(
  result: CompanyScan,
  old: RetainedOpening,
  get: CareersFetch,
  signal: AbortSignal,
) {
  try {
    const p = await get(old.url);
    const desc = text(p.text);
    const jobs = p.status === 200 ? htmlJobs(p) : [];
    if (
      jobs.length === 1 &&
      plain(jobs[0].title).toLowerCase() === plain(old.title).toLowerCase()
    ) {
      const job = customJob(jobs[0], p, old);
      result.jobs.push(job);
      result.direct[old.job_id] = {
        status: "open",
        reason: "Direct posting includes matching structured job details",
        at: p.at,
        job,
      };
    } else if (
      (result.complete && [404, 410].includes(p.status)) ||
      explicitlyClosed(p)
    ) {
      result.direct[old.job_id] = {
        status: "closed",
        reason: `Direct posting explicitly unavailable (${p.status}); ${result.complete ? "complete board checked" : "inventory incomplete"}`,
        at: p.at,
      };
    } else
      result.direct[old.job_id] = {
        status: "unknown",
        reason: `Direct URL returned ${p.status} without verified matching job details${result.complete ? "; absent from the complete inventory" : ""}`,
        at: p.at,
      };
  } catch (e) {
    if (signal.aborted) throw e;
    result.direct[old.job_id] = {
      status: "unknown",
      reason: errorMessage(e),
      at: new Date().toISOString(),
    };
  }
}

async function reconcileRetainedPostings(
  result: CompanyScan,
  retained: RetainedOpenings,
  completeBoard: SupportedBoard | undefined,
  get: CareersFetch,
  signal: AbortSignal,
  notes: string[],
) {
  for (const old of retained) {
    if (retiredJobBoard(old.url)) {
      result.direct[old.job_id] = {
        status: "unknown",
        reason: "Ashby/Lever integrations are retired",
        at: result.checked_at,
      };
      continue;
    }
    const match =
      result.jobs.find((j) => j.id === old.job_id) ||
      result.jobs.find((j) => canonicalUrl(j.url) === canonicalUrl(old.url));
    if (match) {
      if (!match.detailVerified) {
        if (result.result === "SUCCESS") result.result = "PARTIAL";
        notes.push(`Posting details unverified for ${old.job_id}`);
      }
      match.id = old.job_id;
      result.direct[old.job_id] = {
        status: "open",
        reason: "Requisition is present in the current official inventory",
        at: match.at,
        job: match,
      };
      continue;
    }
    if (completeBoard && result.complete) {
      const detailUrl = retainedApiUrl(completeBoard, old);
      if (
        detailUrl &&
        (await checkRetainedApi(
          result,
          old,
          completeBoard,
          detailUrl,
          get,
          signal,
          notes,
        ))
      )
        continue;
    }
    await checkRetainedPage(result, old, get, signal);
  }
}

function finalizeCompanyScan(result: CompanyScan, notes: string[]) {
  if (Object.values(result.direct).some((d) => d.status === "unknown")) {
    if (result.result === "SUCCESS") result.result = "PARTIAL";
    notes.push(
      "Some retained direct postings remain unconfirmed: " +
        Object.entries(result.direct)
          .filter(([, d]) => d.status === "unknown")
          .map(([id]) => id)
          .join(", "),
    );
  }
  result.jobs = [
    ...new Map(
      result.jobs.map((j) => [j.id, { ...j, fingerprint: jobFingerprint(j) }]),
    ).values(),
  ];
  result.notes =
    notes.join(" ") ||
    "Complete public inventory retrieved; new matches receive provisional screening, not a full editorial fit review.";
  result.checked_at = new Date().toISOString();
  return result;
}

// One options bag so new collection inputs do not lengthen the positional list.
export type CollectOptions = { settings?: () => TunableSettings };

export async function collectCompany(
  company: CareersCompany,
  prior: PriorCompanyScan,
  retained: RetainedCareerOpening[],
  fetch: CareersFetch,
  signal: AbortSignal,
  browser?: (url: string) => Promise<CareersResponse>,
  options: CollectOptions = {},
): Promise<CompanyScan> {
  const career = String(company.fields?.["Careers URL"] || "");
  const result: CompanyScan = {
    company_id: company.id,
    company: company.name,
    result: "FAILED",
    inventory_count: null,
    complete: false,
    sources: [],
    notes: "",
    checked_at: new Date().toISOString(),
    jobs: [],
    direct: {},
  };
  const notes: string[] = [];
  const limits = scanLimits((options.settings ?? (() => ({})))());
  const get: CareersFetch = async (url, body) => {
    signal.throwIfAborted();
    if (retiredJobBoard(url))
      throw Error("Ashby/Lever integrations are retired");
    if (!result.sources.includes(url)) result.sources.push(url);
    const response = await fetch(url, body);
    if (retiredJobBoard(response.url))
      throw Error("Ashby/Lever integrations are retired");
    return response;
  };
  const { landing, links } = await loadLanding(career, get, signal, notes);
  const boards = discoverBoards(career, links, prior);
  const completeBoard = await collectSupportedBoards(
    boards,
    retained,
    get,
    signal,
    result,
    notes,
    limits,
  );
  const browserResult = await tryBrowserFallback(
    company,
    prior,
    retained,
    fetch,
    signal,
    browser,
    career,
    landing,
    result,
    notes,
    options,
  );
  if (browserResult) return browserResult;
  await collectCustomInventory(
    landing,
    retained,
    get,
    signal,
    result,
    notes,
    limits,
  );
  await reconcileRetainedPostings(
    result,
    retained,
    completeBoard,
    get,
    signal,
    notes,
  );
  return finalizeCompanyScan(result, notes);
}
