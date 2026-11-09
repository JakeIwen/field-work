import { tunables } from "../../shared/tunables.js";
import * as openingSkillFields from "../opening-skills-fields.js";
import { parseOpenings } from "../importer.js";
import type { FitCriteria } from "../../shared/fit-criteria.js";
import { validOpeningAssessmentDetails } from "../../shared/opening-assessments.js";
import { validOpeningListSummary } from "../../shared/opening-list.js";
import {
  candidate,
  canonicalUrl,
  jobFingerprint,
  type CompanyScan,
  type ScanJob,
} from "./providers.js";
const line = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const key = (o: any) => `${o.company_id}:${o.job_id}`;
function provisional(
  job: ScanJob,
  company: any,
  firstSeen: string,
  descriptionChars: () => number,
) {
  return {
    id: `${company.id}:${job.id}`,
    company_id: company.id,
    job_id: job.id,
    company: company.name,
    title: job.title,
    url: job.url,
    location:
      job.location || "Not specified; confirm US work-location eligibility.",
    compensation:
      job.salary ||
      "No published salary detected in the captured posting. Confirm base salary, currency and geographic bands.",
    technical_fit: "Unknown",
    remote_fit: "Unknown",
    wlb_outlook: "Unknown",
    why: "Provisional discovery: the title and remote wording pass an automated screening rule. Review the current resume and evidence dossier before assessing fit.",
    concerns:
      "Not yet fit-reviewed. Confirm permitted US work locations, actual hours, on-call, travel and published base compensation. Company suitability does not establish this role’s working conditions.",
    requirements:
      job.description.slice(0, descriptionChars()) ||
      "Posting details need review.",
    wlb_evidence: `Company research (${company.sourceDate || "date unknown"}) is carried forward, not refreshed by this vacancy scan. [Official posting](${job.url}).`,
    first_seen: firstSeen,
    last_confirmed_open: job.at.slice(0, 10),
    postingStatus: "confirmed open at last scan",
    reviewRequired: true,
    assessmentDate: null,
    deadline: job.deadline ?? null,
  };
}
type ReconcileInput = {
  companies: any[];
  previous: any;
  openings: any[];
  results: CompanyScan[];
  id: string;
  completedAt: string;
  mode: string;
  fitCriteria?: FitCriteria;
  descriptionChars?: () => number;
};
type Company = ReconcileInput["companies"][number];
type Opening = ReconcileInput["openings"][number];
type ScanResult = ReconcileInput["results"][number];
type ListedJob = ScanResult["jobs"][number];
type DirectCheck = ScanResult["direct"][string];
type SeenJobs = NonNullable<ReconcileInput["previous"]["seen_jobs"]>;
type SeenJob = SeenJobs[string];
type OpeningMap = Map<string, Opening>;
type ReconciliationChange = {
  kind: string;
  id: string;
  company: string;
  title: string;
  reason: string;
};

function initializeReconciliation(input: ReconcileInput) {
  const { previous, results } = input;
  const byCompany = new Map(results.map((r) => [r.company_id, r]));
  const seen = structuredClone(previous.seen_jobs || {});
  const originalSeen = previous.seen_jobs || {};
  const active = new Map(input.openings.map((o) => [key(o), { ...o }]));
  const archive = new Map<string, Opening>(
    (previous.archived_openings || []).map((o: Opening) => [key(o), { ...o }]),
  );
  const changes: ReconciliationChange[] = [];
  return { byCompany, seen, originalSeen, active, archive, changes };
}

function rememberListedJob(
  seen: SeenJobs,
  active: OpeningMap,
  archive: OpeningMap,
  result: ScanResult,
  job: ListedJob,
) {
  const k = `${result.company_id}:${job.id}`,
    old = seen[k];
  seen[k] = {
    ...old,
    company_id: result.company_id,
    job_id: job.id,
    title: job.title,
    location: job.location,
    url: job.url,
    first_seen:
      old?.first_seen ??
      active.get(k)?.first_seen ??
      archive.get(k)?.first_seen ??
      (old ? null : job.at.slice(0, 10)),
    last_seen: job.at.slice(0, 10),
    last_confirmed_listed: job.at.slice(0, 10),
    automated_fingerprint: job.detailVerified
      ? job.fingerprint || jobFingerprint(job)
      : old?.automated_fingerprint,
    fingerprint_schema: "fieldwork-public-v1",
    qualification: old?.qualification || "not_retained",
  };
  return { old, k };
}

function retainCandidate(
  job: ListedJob,
  company: Company,
  result: ScanResult,
  old: SeenJob,
  originalSeen: SeenJobs,
  seen: SeenJobs,
  active: OpeningMap,
  archive: OpeningMap,
  changes: ReconciliationChange[],
  fitCriteria: ReconcileInput["fitCriteria"],
  descriptionChars: () => number,
) {
  const k = `${result.company_id}:${job.id}`;
  if (!active.has(k) && candidate(job, fitCriteria) && job.detailVerified) {
    const prior = archive.get(k);
    const possibleRepost = Object.values(originalSeen).find(
      (s: SeenJob) =>
        s.company_id === result.company_id &&
        s.job_id !== job.id &&
        line(s.title).toLowerCase() === line(job.title).toLowerCase(),
    );
    const o = prior
      ? { ...prior }
      : provisional(job, company, seen[k].first_seen, descriptionChars);
    o.status = prior
      ? "CHANGED"
      : old || possibleRepost
        ? "PREVIOUSLY SEEN"
        : "NEW";
    o.last_confirmed_open = job.at.slice(0, 10);
    o.postingStatus = "confirmed open at last scan";
    o.retained = true;
    o.lastCheckedAt = job.at;
    o.verificationNotes = prior
      ? "Reappeared in the official inventory. Review the current posting."
      : possibleRepost
        ? "Possible repost: similar title exists under a previous requisition. Identity was preserved separately."
        : "New automated candidate; complete fit review is pending.";
    if (prior) {
      o.title = job.title;
      o.location = job.location;
      o.reviewRequired = true;
      archive.delete(k);
    }
    active.set(k, o);
    changes.push({
      kind: prior ? "reopened" : "new",
      id: k,
      company: company.name,
      title: job.title,
      reason: o.verificationNotes,
    });
    seen[k].qualification = "retained";
  }
}

function closeAbsentOpening(
  k: string,
  o: Opening,
  direct: DirectCheck,
  seen: SeenJobs,
  active: OpeningMap,
  archive: OpeningMap,
  changes: ReconciliationChange[],
) {
  const closed = {
    ...o,
    postingStatus: "closed",
    retained: false,
    closedAt: direct.at,
    lastCheckedAt: direct.at,
    verificationNotes: direct.reason,
    status: "PREVIOUSLY SEEN",
  };
  archive.set(k, closed);
  active.delete(k);
  seen[k] = {
    ...seen[k],
    posting_status: "closed",
    last_checked_at: direct.at,
    closure_evidence: {
      url: o.url,
      at: direct.at,
      reason: direct.reason,
    },
  };
  changes.push({
    kind: "closed",
    id: k,
    company: o.company,
    title: o.title,
    reason: direct.reason,
  });
}

function markUnconfirmedOpening(
  k: string,
  o: Opening,
  direct: DirectCheck | undefined,
  result: ScanResult,
  seen: SeenJobs,
  changes: ReconciliationChange[],
) {
  o.postingStatus = "not confirmed open";
  o.lastCheckedAt = direct?.at || result.checked_at;
  o.verificationNotes =
    direct?.reason || "The company inventory was not completely verified.";
  o.status = "PREVIOUSLY SEEN";
  changes.push({
    kind: "unconfirmed",
    id: k,
    company: o.company,
    title: o.title,
    reason: o.verificationNotes,
  });
  if (seen[k])
    seen[k] = {
      ...seen[k],
      posting_status: "unknown",
      last_checked_at: o.lastCheckedAt,
    };
}

function postingChanged(current: ListedJob, before: SeenJob, o: Opening) {
  return current.detailVerified && before?.automated_fingerprint
    ? before.automated_fingerprint !== jobFingerprint(current)
    : !!before &&
        (line(before.title).toLowerCase() !==
          line(current.title).toLowerCase() ||
          canonicalUrl(before.url || "") !== canonicalUrl(current.url) ||
          (!!before.location &&
            current.detailVerified &&
            line(before.location) !== line(current.location)) ||
          (!!o.description &&
            current.detailVerified &&
            line(o.description) !== line(current.description)));
}

function updateChangedPosting(
  o: Opening,
  current: ListedJob,
  isNew: boolean,
  changes: ReconciliationChange[],
  k: string,
  descriptionChars: () => number,
) {
  o.title = current.title;
  o.url = current.url;
  o.location = current.location || "Location not specified";
  if (current.detailVerified) {
    o.compensation =
      current.salary ||
      "No published salary detected in the refreshed posting; previous pay terms require reconfirmation.";
    o.requirements = current.description.slice(0, descriptionChars());
    o.deadline = current.deadline ?? null;
  }
  o.reviewRequired = true;
  o.assessmentDate = o.assessmentDate || o.sourceDate?.slice(0, 10) || null;
  o.verificationNotes +=
    "; posting data changed, prior fit assessment needs review";
  if (!isNew)
    changes.push({
      kind: "changed",
      id: k,
      company: o.company,
      title: o.title,
      reason: o.verificationNotes,
    });
}

function refreshMatchedOpening(
  k: string,
  o: Opening,
  current: ListedJob,
  direct: DirectCheck | undefined,
  originalSeen: SeenJobs,
  seen: SeenJobs,
  changes: ReconciliationChange[],
  descriptionChars: () => number,
) {
  const before = originalSeen[k];
  const changed = postingChanged(current, before, o);
  const isNew = changes.some(
    (c) => c.id === k && ["new", "reopened"].includes(c.kind),
  );
  if (!isNew) o.status = changed ? "CHANGED" : "PREVIOUSLY SEEN";
  if (current.detailVerified)
    o.postingFingerprint = current.fingerprint || jobFingerprint(current);
  o.last_confirmed_open = current.at.slice(0, 10);
  o.postingStatus = "confirmed open at last scan";
  o.lastCheckedAt = current.at;
  o.verificationNotes = isNew
    ? o.verificationNotes
    : direct?.reason || "Present in official public inventory";
  o.retained = true;
  if (changed)
    updateChangedPosting(o, current, isNew, changes, k, descriptionChars);
  if (!current.detailVerified) {
    o.reviewRequired = true;
    o.verificationNotes +=
      "; description refresh incomplete, prior terms remain dated context";
  }
  if (seen[k]) {
    seen[k].qualification = "retained";
    seen[k].posting_status = "open";
    seen[k].last_checked_at = current.at;
  }
}

function reconcileCurrentOpenings(
  result: ScanResult,
  originalSeen: SeenJobs,
  seen: SeenJobs,
  active: OpeningMap,
  archive: OpeningMap,
  changes: ReconciliationChange[],
  descriptionChars: () => number,
) {
  for (const [k, o] of [...active]) {
    if (o.company_id !== result.company_id) continue;
    const direct = result.direct[o.job_id];
    const job =
      result.jobs.find((j) => j.id === o.job_id) ||
      result.jobs.find((j) => canonicalUrl(j.url) === canonicalUrl(o.url));
    if (direct?.status === "closed" && !job) {
      closeAbsentOpening(k, o, direct, seen, active, archive, changes);
      continue;
    }
    if (!job && direct?.status !== "open") {
      markUnconfirmedOpening(k, o, direct, result, seen, changes);
      continue;
    }
    const current = job || direct!.job!;
    refreshMatchedOpening(
      k,
      o,
      current,
      direct,
      originalSeen,
      seen,
      changes,
      descriptionChars,
    );
  }
}

function buildCompanyCoverage(
  companies: ReconcileInput["companies"],
  byCompany: Map<string, ScanResult>,
  previous: ReconcileInput["previous"],
  openings: ReconcileInput["openings"],
) {
  return companies.map((c) => {
    const r = byCompany.get(c.id);
    if (r)
      return {
        company_id: c.id,
        company: c.name,
        result: r.result,
        inventory_count: r.inventory_count,
        qualifying_openings: openings.filter((o) => o.company_id === c.id)
          .length,
        sources: r.sources,
        notes: r.notes,
        checked_at: r.checked_at,
        complete_inventory: r.complete,
      };
    const old = (previous.company_results || []).find(
      (p: Company) => p.company_id === c.id,
    );
    return {
      ...old,
      company_id: c.id,
      company: c.name,
      result: old?.result || "UNKNOWN",
      sources: old?.sources || [],
      checked_at: old?.checked_at || previous.last_scan_completed || null,
      notes:
        (old?.notes || "Not previously checked") +
        " Retained from an earlier check; not attempted in this retry.",
    };
  });
}

function buildScanSummary(
  companies: ReconcileInput["companies"],
  results: ReconcileInput["results"],
  changes: ReconciliationChange[],
  openings: ReconcileInput["openings"],
  seen: SeenJobs,
) {
  return {
    attempted: results.length,
    monitored: companies.length,
    successful: results.filter((r) => r.result === "SUCCESS").length,
    failed: results.filter((r) => r.result !== "SUCCESS").length,
    new: changes.filter((c) => c.kind === "new").length,
    changed: changes.filter((c) => c.kind === "changed").length,
    reopened: changes.filter((c) => c.kind === "reopened").length,
    closed: changes.filter((c) => c.kind === "closed").length,
    unconfirmed: changes.filter((c) => c.kind === "unconfirmed").length,
    retained: openings.length,
    confirmed: openings.filter(
      (o) => o.postingStatus === "confirmed open at last scan",
    ).length,
    seen: Object.keys(seen).length,
  };
}

function buildScanState(
  input: ReconcileInput,
  seen: SeenJobs,
  archive: OpeningMap,
  openings: ReconcileInput["openings"],
  coverage: ReturnType<typeof buildCompanyCoverage>,
  summary: ReturnType<typeof buildScanSummary>,
) {
  const { companies, previous, id, completedAt, mode } = input;
  return {
    ...previous,
    schema_version: 1,
    baseline: false,
    last_scan_id: id,
    last_scan_completed: completedAt,
    last_full_scan_completed:
      mode === "all"
        ? completedAt
        : previous.last_full_scan_completed || previous.last_scan_completed,
    previous_completed_scan: previous.last_scan_id,
    app_custom_company_ids: [
      ...new Set([
        ...(previous.app_custom_company_ids || []),
        ...companies.filter((c) => c.personalCompany).map((c) => c.id),
      ]),
    ],
    active_company_ids: companies.map((c) => c.id),
    pool_selection: "app monitored",
    company_results: coverage,
    current_opening_keys: openings.map(key),
    seen_jobs: seen,
    archived_openings: [...archive.values()],
    comparison_notes: [
      "Explicit user-triggered public careers scan. New candidates have provisional screening, not a new editorial fit rating.",
      "All previous seen identities and archived qualified roles are preserved. Access failures do not prove closure.",
      "Companies outside a retry keep their own original checked_at timestamp.",
      "The first automated fingerprint establishes a new comparison baseline; historical fingerprints are not comparable.",
    ],
    last_scan_summary: summary,
  };
}

export function reconcileScan(input: ReconcileInput) {
  const { companies, previous, results } = input;
  const descriptionChars =
    input.descriptionChars ??
    (() => tunables["careers.descriptionChars"].default);
  const { byCompany, seen, originalSeen, active, archive, changes } =
    initializeReconciliation(input);
  for (const result of results) {
    const company = companies.find((c) => c.id === result.company_id)!;
    for (const job of result.jobs) {
      const { old } = rememberListedJob(seen, active, archive, result, job);
      retainCandidate(
        job,
        company,
        result,
        old,
        originalSeen,
        seen,
        active,
        archive,
        changes,
        input.fitCriteria,
        descriptionChars,
      );
    }
    reconcileCurrentOpenings(
      result,
      originalSeen,
      seen,
      active,
      archive,
      changes,
      descriptionChars,
    );
  }
  const openings = [...active.values()].sort(
    (a, b) =>
      a.company.localeCompare(b.company) || a.title.localeCompare(b.title),
  );
  const coverage = buildCompanyCoverage(
    companies,
    byCompany,
    previous,
    openings,
  );
  const summary = buildScanSummary(companies, results, changes, openings, seen);
  const state = buildScanState(
    input,
    seen,
    archive,
    openings,
    coverage,
    summary,
  );
  return { openings, state, coverage, summary, changes };
}
const fields: [string, string][] = [
  ["Job URL", "url"],
  ["Location / remote status", "location"],
  ["Compensation", "compensation"],
  ["Technical fit", "technical_fit"],
  ["Remote fit", "remote_fit"],
  ["WLB outlook", "wlb_outlook"],
  ["Status", "status"],
  ["Posting status", "postingStatus"],
  ["First seen", "first_seen"],
  ["First published", "first_published"],
  ["Last confirmed open", "last_confirmed_open"],
  ["Last checked", "lastCheckedAt"],
  ["Posting fingerprint", "postingFingerprint"],
  ["Needs fit review", "reviewRequired"],
  ["Assessment date", "assessmentDate"],
  ["Verification notes", "verificationNotes"],
  ["Application deadline", "deadline"],
  ["Why it fits", "why"],
  ["Main concerns", "concerns"],
  ["Key requirements", "requirements"],
  ["Useful WLB evidence", "wlb_evidence"],
];
function openingSupplementFields(o: any): [string, unknown][] {
  const extra: [string, unknown][] = [];
  if (
    validOpeningAssessmentDetails(o.assessmentDetails) &&
    (!o.assessmentSourceHash || o.assessmentSourceHash === o.hash)
  )
    extra.push(
      ["Technical fit assessment", o.assessmentDetails.technicalFit],
      ["Remote fit assessment", o.assessmentDetails.remoteFit],
      ["WLB assessment", o.assessmentDetails.wlbOutlook],
    );
  if (
    validOpeningListSummary(o.listSummary) &&
    (!o.listSummarySourceHash || o.listSummarySourceHash === o.hash)
  )
    extra.push(
      ["List location", o.listSummary.location],
      ["List technical fit", o.listSummary.technicalFit],
      ["List WLB outlook", o.listSummary.wlbOutlook],
      ["List compensation", o.listSummary.compensation],
    );
  extra.push(...openingSkillFields.supplement(o));
  if (o.dateSources?.firstPublishedAt)
    extra.push(["Publication source", o.dateSources.firstPublishedAt]);
  if (o.dateSources?.deadline)
    extra.push(["Deadline source", o.dateSources.deadline]);
  return extra;
}
export function openingsMarkdown(
  openings: any[],
  stamp: string,
  snapshot: string,
) {
  return (
    `# Current openings\n\n**Scan completed:** ${stamp}\n**Qualifying current openings:** ${openings.length}\n\nThis is the retained opportunity list, including unconfirmed roles and provisional candidates that need fit review. It is separate from all seen ATS identities. Published salary wording and geographic bands are preserved. A failed check does not establish closure. Company WLB research is carried forward with its original date.\n\n[Scan evidence and limitations](${snapshot}/README.md)\n\n` +
    openings
      .map(
        (o) =>
          `### ${line(o.company)} — ${line(o.title)}\n<!-- company_id: ${o.company_id}; job_id: ${o.job_id} -->\n\n` +
          [
            ...fields.map(([name, key]) => [name, o[key]] as [string, unknown]),
            ...openingSupplementFields(o),
          ]
            .map(
              ([name, value]) =>
                `* **${name}:** ${line(value === true ? "yes" : value === false ? "no" : value) || "unknown"}`,
            )
            .join("\n"),
      )
      .join("\n\n") +
    "\n"
  );
}
export function validateReconciliation(
  value: ReturnType<typeof reconcileScan>,
  markdown: string,
  previous: any,
) {
  const parsed = parseOpenings(markdown);
  if (
    parsed.length !== value.openings.length ||
    new Set(parsed.map((o) => o.id)).size !== parsed.length
  )
    throw Error("Opening report identity/count validation failed");
  for (const o of parsed) {
    if (!value.state.current_opening_keys.includes(o.id))
      throw Error("Report and scan state disagree");
    if (o.postingStatus === "closed")
      throw Error(
        "Closed roles must remain in archived research, not current opportunities",
      );
  }
  if (
    Object.keys(previous.seen_jobs || {}).some(
      (id) => !value.state.seen_jobs[id],
    )
  )
    throw Error("Seen identity history would be lost");
  if (
    new Set(value.coverage.map((c) => c.company_id)).size !==
    value.state.active_company_ids.length
  )
    throw Error("Company coverage validation failed");
  return {
    status: "passed",
    checks: [
      "Unique current requisitions and matching Markdown/state/snapshot",
      "All seen identities preserved",
      "One dated outcome per monitored company",
      "Closed roles archived separately; unconfirmed roles retained",
    ],
  };
}

export function selectedPostingEvidence(
  openings: any[],
  results: CompanyScan[],
  previous: any[],
) {
  return openings.flatMap<any>((o) => {
    const fresh = results
      .find((r) => r.company_id === o.company_id)
      ?.jobs.find(
        (j) => j.id === o.job_id && j.detailVerified && j.description,
      );
    if (fresh) return [{ ...fresh, company_id: o.company_id }];
    const old = previous.find(
      (p) => p.company_id === o.company_id && p.job_id === o.job_id,
    );
    if (!old?.description) return [];
    return [
      {
        id: o.job_id,
        company_id: o.company_id,
        title: o.title,
        url: o.url,
        description: old.description,
        confirmed_at: old.descriptionConfirmedAt ?? null,
        compensation: old.publishedCompensation ?? null,
        carried_forward: true,
        previous_source_path: old.descriptionSourcePath ?? null,
      },
    ];
  });
}
