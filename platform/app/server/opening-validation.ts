import { tunableMs } from "./tunables.js";
import { tunableValue, type TunableSettings } from "../shared/tunables.js";
import { diagnosticLog } from "./diagnostic-log.js";
import { retiredJobBoard } from "../shared/posting-url.js";
import { payloadProperty } from "./careers/provider-payloads.js";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { load } from "cheerio";
import { Store, HttpError, atomicWrite, sha256, now } from "./storage.js";
import { canonicalPosting, postingUrl } from "./job-posting.js";
import {
  boardEndpoint,
  normalizeFeed,
  htmlJobs,
  collectCompany,
} from "./careers/providers.js";
import {
  publicCareersFetch,
  type CareersFetch,
  type CareersResponse,
} from "./careers/http.js";
import { ResumableJob } from "./resumable-job.js";
import type { Records } from "./records.js";
import {
  isActiveOpening,
  isClosedOpening,
  type OpeningValidation,
} from "../shared/opening-availability.js";
import type { Opening } from "../shared/types.js";

type ValidationRun = Records["opening_validation_run"];
type ValidationTarget = ValidationRun["targets"][number];
type Verdict = Pick<OpeningValidation, "status" | "reason"> & {
  sourceUrl?: string;
};
type ValidationOpening = Pick<
  Opening,
  "url" | "job_id" | "company_id" | "company"
>;
type SupportedBoard = NonNullable<ReturnType<typeof boardEndpoint>>;
type OpeningContext = {
  url: URL;
  board: SupportedBoard | null;
  id: string | undefined;
};
function openingContext(opening: ValidationOpening): OpeningContext {
  const url = postingUrl(opening.url);
  const board = boardEndpoint(url.href);
  const parts = url.pathname.split("/").filter(Boolean);
  const id =
    board?.kind === "greenhouse"
      ? url.searchParams.get("token") || parts.at(-1)
      : opening.job_id;
  return { url, board, id };
}
const unknown = (reason: string, sourceUrl?: string): Verdict => ({
  status: "unknown",
  reason,
  sourceUrl,
});
const canonical = (url: string) => {
  try {
    return canonicalPosting(url);
  } catch {
    return "";
  }
};

function officialPostingVerdict(
  page: CareersResponse,
  board: SupportedBoard,
  detailUrl: string,
  id: string,
): Verdict | undefined {
  if (canonical(page.url) !== canonical(detailUrl))
    return unknown(
      "Official posting API redirected; identity could not be verified",
      page.url,
    );
  if (
    page.status !== 200 &&
    /access denied|verify you are human|captcha|checking your browser/i.test(
      page.text,
    )
  )
    return unknown("Official posting API blocked this check", detailUrl);
  if (page.status === 200) {
    const raw = JSON.parse(page.text);
    const jobs = normalizeFeed(board.kind, { jobs: [raw] }, detailUrl, page.at);
    if (jobs[0]?.id === id && jobs[0].detailVerified)
      return {
        status: "open",
        reason:
          "Matching posting is available from the employer's official job API",
        sourceUrl: detailUrl,
      };
    return unknown(
      "Official API did not return matching posting details",
      detailUrl,
    );
  }
  if (![404, 410].includes(page.status))
    return unknown(
      `Official posting API returned HTTP ${page.status}`,
      detailUrl,
    );
  return undefined;
}

function officialMissingVerdict(
  inventory: CareersResponse,
  board: SupportedBoard,
  id: string,
  detailPage: CareersResponse,
  detailUrl: string,
): Verdict {
  // Confirm the board still works before interpreting a missing individual posting.
  if (
    inventory.status === 200 &&
    canonical(inventory.url) === canonical(board.url)
  ) {
    const jobs = normalizeFeed(
      board.kind,
      JSON.parse(inventory.text),
      board.url,
      inventory.at,
    );
    if (jobs.some((j) => j.id === id))
      return unknown("Posting API and current board disagree", detailUrl);
    if (jobs.length || board.kind === "greenhouse")
      return {
        status: "closed",
        reason: `Official posting API returned HTTP ${detailPage.status}; employer board is available and does not list this posting`,
        sourceUrl: detailUrl,
      };
  }
  return unknown(
    "Posting was unavailable, but its employer board could not confirm removal",
    detailUrl,
  );
}

function workdayPostingVerdict(
  page: CareersResponse,
  detailUrl: string,
  opening: ValidationOpening,
): Verdict | undefined {
  if (canonical(page.url) !== canonical(detailUrl))
    return unknown(
      "Workday API redirected; identity could not be verified",
      page.url,
    );
  if (
    page.status !== 200 &&
    /access denied|verify you are human|captcha|checking your browser/i.test(
      page.text,
    )
  )
    return unknown("Workday blocked this check", detailUrl);
  if (page.status === 200) {
    const job = JSON.parse(page.text).jobPostingInfo;
    if (job?.jobReqId === opening.job_id && job.jobDescription)
      return {
        status: "open",
        reason:
          "Matching requisition is available from the employer's Workday API",
        sourceUrl: detailUrl,
      };
    return unknown(
      "Workday did not return matching requisition details",
      detailUrl,
    );
  }
  if (![404, 410].includes(page.status))
    return unknown(`Workday returned HTTP ${page.status}`, detailUrl);
  return undefined;
}

function employerClosureNotice(
  $: ReturnType<typeof load>,
  visible: string,
  settings: TunableSettings,
) {
  const closure =
    /\b(?:this (?:job|position|role) (?:is |has been )?(?:no longer available|closed|filled)|(?:job|position) (?:has been closed|is no longer posted)|(?:we are |we're )?no longer accepting applications(?: for this (?:job|position|role))?[.!]?\s*$)/i;
  const notice = $("h1,h2,[role=alert]")
    .toArray()
    .map((e) => $(e).text().trim())
    .find((t) => closure.test(t));
  const text =
    notice ||
    (visible.length < tunableValue(settings, "validation.shortPageChars") &&
    closure.test(visible)
      ? visible
      : undefined);
  return text?.slice(0, tunableValue(settings, "validation.noticeChars"));
}

/** A successful generic page is only positive evidence when it identifies this job. */
export function inspectPosting(
  page: CareersResponse,
  opening: any,
  absent = false,
  settings: TunableSettings = {},
): Verdict {
  const sourceUrl = page.url;
  const samePage = canonical(page.url) === canonical(opening.url);
  const $ = load(page.text);
  $("script,style,noscript,nav,header,footer").remove();
  const visible = ($("main").length ? $("main").text() : $("body").text())
    .replace(/\s+/g, " ")
    .trim();
  if (
    /access denied|verify you are human|checking your browser|captcha|rate limit|too many requests/i.test(
      visible,
    )
  )
    return unknown(
      "The employer site blocked or limited this check",
      sourceUrl,
    );
  // A redirect to a board, a generic 404, or an old deadline alone is not closure.
  if (samePage && absent && [404, 410].includes(page.status))
    return {
      status: "closed",
      reason: `Posting returned HTTP ${page.status} and is absent from the verified current board`,
      sourceUrl,
    };
  if (page.status !== 200)
    return unknown(`Employer returned HTTP ${page.status}`, sourceUrl);
  const notice = samePage && employerClosureNotice($, visible, settings);
  if (notice)
    return {
      status: "closed",
      reason: `Employer notice: ${notice}`,
      sourceUrl,
    };
  const jobs = htmlJobs(page);
  const match = jobs.find((j) => {
    const id = String(
      payloadProperty(j.identifier, "value") ?? j.identifier ?? "",
    );
    return (
      (j.url &&
        canonical(new URL(String(j.url), page.url).href) ===
          canonical(opening.url)) ||
      (samePage &&
        jobs.length === 1 &&
        String(j.title).toLowerCase().trim() ===
          String(opening.title).toLowerCase().trim() &&
        (!id || id === opening.job_id))
    );
  });
  if (match?.description) {
    // Structured deadlines are often stale; flag for review instead of claiming closure.
    if (
      match.validThrough &&
      Date.parse(String(match.validThrough)) < Date.now()
    )
      return unknown(
        "Matching posting remains online but its structured deadline has passed",
        sourceUrl,
      );
    return {
      status: "open",
      reason: "Employer page contains matching structured job details",
      sourceUrl,
    };
  }
  return unknown(
    samePage
      ? "Page did not provide verifiable matching job details"
      : "Posting redirected; closure could not be established",
    sourceUrl,
  );
}

export async function validateOpening(
  opening: any,
  get: CareersFetch,
  signal: AbortSignal,
  settings: () => TunableSettings = () => ({}),
): Promise<Verdict> {
  if (retiredJobBoard(opening.url))
    return unknown(
      "Ashby/Lever integrations are retired; check this posting manually",
      opening.url,
    );
  const { url, board, id } = openingContext(opening);
  if (board && board.kind === "greenhouse" && id && /^\d+$/.test(id)) {
    const detailUrl = board.url.split("?")[0] + "/" + id;
    const page = await get(detailUrl);
    const verdict = officialPostingVerdict(page, board, detailUrl, id);
    if (verdict) return verdict;
    const inventory = await get(board.url);
    return officialMissingVerdict(inventory, board, id, page, detailUrl);
  }
  if (board?.kind === "workday" && url.pathname.includes("/job/")) {
    const detailUrl =
      board.url.replace(/\/jobs$/, "") +
      url.pathname.slice(url.pathname.indexOf("/job/"));
    const page = await get(detailUrl);
    const verdict = workdayPostingVerdict(page, detailUrl, opening);
    if (verdict) return verdict;
    // Reuse the scanner's stable, complete Workday pagination before marking removal.
    const result = await collectCompany(
      {
        id: opening.company_id,
        name: opening.company,
        fields: { "Careers URL": url.href },
      },
      undefined,
      [opening],
      get,
      signal,
    );
    const collected = result.direct[opening.job_id];
    return collected
      ? {
          status: collected.status,
          reason: collected.reason,
          sourceUrl: detailUrl,
        }
      : unknown(result.notes, detailUrl);
  }
  return inspectPosting(await get(url.href), opening, false, settings());
}

export class OpeningValidationManager extends ResumableJob<"opening_validation_run"> {
  constructor(
    private store: Store,
    private notify: () => void,
    private fetchOverride?: CareersFetch,
    private paceMs?: number,
  ) {
    super(store, notify, "opening_validation_run");
    this.recoverInterruptedRuns({
      eligibleStatuses: ["running"],
      interrupt: (run) =>
        this.save({
          ...run,
          status: "interrupted",
          error: "Server restarted. Resume to check the remaining openings.",
        }),
    });
  }
  state() {
    return this.store.list("opening_validation_run").at(-1) ?? null;
  }
  private save(run: any) {
    this.saveRun(run);
  }
  start(openingId?: string) {
    if (this.running) {
      if (openingId)
        throw new HttpError(409, "Wait for the current validation to finish");
      return this.state();
    }
    // A bulk run skips Not interested postings: their availability changes nothing the user acts on.
    const targets = openingId
      ? [this.store.opening(openingId)].filter(Boolean)
      : this.store
          .openings()
          .filter(
            (o) =>
              isActiveOpening(o) &&
              !this.store.get("personal", o.id)?.dismissed,
          );
    if (!targets.length) throw new HttpError(400, "No openings to validate");
    const run = {
      id: randomUUID(),
      status: "running",
      startedAt: now(),
      total: targets.length,
      completed: 0,
      counts: { open: 0, closed: 0, unknown: 0 },
      visibilityChanges: { hidden: 0, restored: 0 },
      targets: targets.map((o) => ({ id: o!.id, url: o!.url })),
      results: [],
    };
    this.save(run);
    this.launch(run.id);
    return run;
  }
  resume() {
    if (this.running) return this.state();
    const run = this.state();
    if (!run || !["interrupted", "failed"].includes(run.status))
      throw new HttpError(409, "No interrupted validation to resume");
    this.save({ ...run, status: "running", error: undefined });
    this.launch(run.id);
    return this.state();
  }
  private current(id: string) {
    const run = this.store.get("opening_validation_run", id);
    if (!run)
      diagnosticLog(
        "warn",
        "opening-validation",
        `Skipping missing opening validation run ${id}`,
      );
    return run;
  }
  private launch(id: string) {
    this.launchRun(
      id,
      (signal) => this.run(id, signal),
      (e) => {
        const run = this.current(id);
        if (!run) return;
        this.save({
          ...run,
          status: this.controller?.signal.aborted ? "interrupted" : "failed",
          error: String(e.message),
        });
      },
    );
  }
  private async run(id: string, signal: AbortSignal) {
    const cache = new Map<string, CareersResponse>();
    // Stop contacting a throttled host for this run. A later explicit retry can retry it.
    const limited = new Set<string>();
    const run = this.current(id);
    if (!run) return;
    for (const target of run.targets.slice(run.completed)) {
      signal.throwIfAborted();
      const checked = await this.checkTarget(
        id,
        target,
        signal,
        cache,
        limited,
      );
      if (!checked) return;
    }
    this.recordCompletionSummary(id);
  }
  private async checkTarget(
    id: string,
    target: ValidationTarget,
    signal: AbortSignal,
    cache: Map<string, CareersResponse>,
    limited: Set<string>,
  ): Promise<boolean> {
    const current = this.store.opening(target.id);
    const evidenceHashes: string[] = [];
    const latest = this.current(id);
    if (!latest) return false;
    this.save({
      ...latest,
      current: current ? `${current.company} · ${current.title}` : target.id,
    });
    const get = this.createEvidenceFetcher(
      signal,
      cache,
      limited,
      evidenceHashes,
    );
    let verdict: Verdict;
    try {
      verdict =
        !current || canonical(current.url) !== canonical(target.url)
          ? unknown(
              "Posting URL changed or opening was removed during validation",
            )
          : await validateOpening(current, get, signal, () =>
              this.store.settings(),
            );
    } catch (e: any) {
      if (signal.aborted) throw e;
      verdict = unknown(String(e.message));
    }
    signal.throwIfAborted();
    return this.recordTargetResult(id, target, verdict, evidenceHashes);
  }
  private createEvidenceFetcher(
    signal: AbortSignal,
    cache: Map<string, CareersResponse>,
    limited: Set<string>,
    evidenceHashes: string[],
  ): CareersFetch {
    return async (url, body) => {
      const host = postingUrl(url).host;
      if (limited.has(host))
        throw Error(
          "Employer rate limit encountered earlier in this run; retry later",
        );
      const key = url + JSON.stringify(body ?? null);
      let response = cache.get(key);
      if (!response) {
        await delay(
          this.paceMs ?? tunableMs(this.store, "validation.pauseMs"),
          undefined,
          { signal },
        );
        response = await (this.fetchOverride
          ? this.fetchOverride(url, body)
          : publicCareersFetch(url, signal, body, () => this.store.settings()));
        cache.set(key, response);
      }
      const bytes = gzipSync(
        Buffer.from(JSON.stringify({ ...response, requestBody: body ?? null })),
      );
      const hash = sha256(bytes);
      atomicWrite(this.store.objectPath(hash), bytes);
      evidenceHashes.push(hash);
      if (
        response.status === 429 ||
        /too many requests|rate limit exceeded/i.test(
          response.text.slice(0, 2000),
        )
      ) {
        limited.add(host);
        throw Error(
          "Employer rate limit encountered; this host will not be retried in this run",
        );
      }
      return response;
    };
  }
  private recordTargetResult(
    id: string,
    target: ValidationTarget,
    verdict: Verdict,
    evidenceHashes: string[],
  ): boolean {
    const progress = this.current(id);
    if (!progress) return false;
    // A concurrent edit must never apply evidence to a different posting URL.
    const after = this.store.opening(target.id);
    const applies = after && canonical(after.url) === canonical(target.url);
    if (!applies)
      verdict = unknown(
        "Posting URL changed or opening was removed during validation",
      );
    const previous = this.store.get("opening_validation", target.id);
    const checkedAt = now();
    const result: OpeningValidation = {
      id: target.id,
      url: target.url,
      ...verdict,
      checkedAt,
      runId: id,
      evidenceHashes,
      ...(verdict.status !== "unknown"
        ? { confirmedStatus: verdict.status, confirmedAt: checkedAt }
        : previous && canonical(previous.url) === canonical(target.url)
          ? {
              confirmedStatus: previous.confirmedStatus,
              confirmedAt: previous.confirmedAt,
            }
          : {}),
    };
    if (applies) {
      const wasClosed = isClosedOpening(after);
      const closed = isClosedOpening({ ...after, validation: result });
      if (closed !== wasClosed)
        result.visibilityChange = closed ? "hidden" : "restored";
      this.store.put("opening_validation", target.id, result);
    }
    const visibilityChanges = progress.visibilityChanges && {
      ...progress.visibilityChanges,
    };
    if (visibilityChanges && result.visibilityChange)
      visibilityChanges[result.visibilityChange]++;
    this.save({
      ...progress,
      completed: progress.completed + 1,
      visibilityChanges,
      counts: {
        ...progress.counts,
        [result.status]: progress.counts[result.status] + 1,
      },
      results: [...progress.results, result],
    });
    return true;
  }
  private recordCompletionSummary(id: string): void {
    const latest = this.current(id);
    if (!latest) return;
    const finished = {
      ...latest,
      status: "completed",
      current: undefined,
      completedAt: now(),
    };
    this.store.journal(
      "openings_validated",
      `Validated ${finished.completed} openings: ${finished.counts.closed} closed, ${finished.counts.unknown} could not verify`,
      id,
    );
    this.save(finished);
  }
}
