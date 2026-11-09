import * as openingSkillFields from "./opening-skills-fields.js";
import { researchFileInstructions } from "./opening-research-policy.js";
import { publicationPullCandidate } from "./opening-pull/publication.js";
import { addGreenhouseResearchContext } from "./greenhouse-research-context.js";
import type { Task } from "../shared/types.js";
import { excludedTechnology } from "./fit-criteria.js";
import { researchPublicationFitCriteria } from "./opening-pull/publication.js";
import {
  openingListSummary,
  openingListLimits,
  validOpeningListSummary,
} from "../shared/opening-list.js";
import {
  openingAssessmentValues,
  isOpeningAssessmentValue,
  normalizeOpeningAssessment,
  validOpeningAssessmentDetails,
  validOpeningDate,
} from "../shared/opening-assessments.js";
import { randomUUID } from "node:crypto";
import {
  Store,
  HttpError,
  MissingRecordError,
  atomicWrite,
  now,
  sha256,
} from "./storage.js";
import { draftPath, collectArtifacts } from "./bundles.js";
import {
  postingUrl,
  canonicalPosting,
  samePostingUrls,
} from "./job-posting.js";
export { canonicalPosting } from "./job-posting.js";
import { syncCompanyContacts } from "./company-contacts.js";
import { salaryBands } from "./importer.js";
import {
  postingIdentity,
  samePostingIdentity,
  normalizeCompanyName,
  normalizeTitle,
} from "../shared/posting-url.js";
import { isActiveOpening } from "../shared/opening-availability.js";
import path from "node:path";

export { openingResearchInstructions } from "./opening-research-policy.js";

const textFields = (keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, { type: "string" }]));
const openingFields = [
  "title",
  "jobId",
  "description",
  "location",
  "compensation",
  "technicalFit",
  "remoteFit",
  "wlbOutlook",
  "why",
  "concerns",
  "wlbEvidence",
];
const assessmentFields = ["technicalFit", "remoteFit", "wlbOutlook"];
const assessmentSchema = {
  type: "object",
  properties: Object.fromEntries(
    assessmentFields.map((key) => [
      key,
      { type: "string", minLength: 1, maxLength: 8000 },
    ]),
  ),
  required: assessmentFields,
  additionalProperties: false,
};
const dateFields = ["firstPublishedAt", "deadline"];
const dateSchema = {
  type: ["string", "null"],
  description:
    "Verified YYYY-MM-DD calendar date or ISO timestamp with timezone; null when unknown. Publication means original publication, never last updated or scanned.",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}(?:T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d))?$",
};
const dateSourcesSchema = {
  type: "object",
  properties: Object.fromEntries(
    dateFields.map((key) => [
      key,
      {
        type: ["string", "null"],
        description:
          "Verified public HTTP(S) URL supporting the corresponding known date; null when the date is unknown.",
        pattern: "^https?://",
      },
    ]),
  ),
  required: dateFields,
  additionalProperties: false,
};
const listSummarySchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(openingListLimits).map(([key, maxLength]) => [
      key,
      { type: "string", minLength: 1, maxLength, pattern: "^[^\\r\\n]+$" },
    ]),
  ),
  required: Object.keys(openingListLimits),
  additionalProperties: false,
};
const companyFields = [
  "companyId",
  "name",
  "officialUrl",
  "careersUrl",
  "description",
  "contactInfo",
  "contactType",
  "contactSourceUrl",
];
export const openingResearchTool = {
  type: "function",
  name: "save_opening_research",
  description:
    "Save source-backed research for the requested Opening and its employer. companyId is an existing companies.json id or empty for a new employer. Unknown fields use Unknown. contactType is address, partial-address or url. Records are published only after this turn completes.",
  inputSchema: {
    type: "object",
    properties: {
      opening: {
        type: "object",
        properties: {
          ...textFields(openingFields),
          ...Object.fromEntries(
            assessmentFields.map((key) => [
              key,
              { type: "string", enum: [...openingAssessmentValues] },
            ]),
          ),
          assessmentDetails: assessmentSchema,
          firstPublishedAt: dateSchema,
          deadline: dateSchema,
          dateSources: dateSourcesSchema,
          listSummary: listSummarySchema,
          skills: openingSkillFields.schema,
          jobId: {
            type: "string",
            description:
              "The employer's requisition ID, or empty if unknown. Never a URL.",
          },
          postingStatus: {
            type: "string",
            enum: ["open", "closed", "unconfirmed"],
          },
        },
        required: [
          ...openingFields,
          "postingStatus",
          "listSummary",
          "skills",
          "assessmentDetails",
          ...dateFields,
          "dateSources",
        ],
        additionalProperties: false,
      },
      company: {
        type: "object",
        properties: textFields(companyFields),
        required: companyFields,
        additionalProperties: false,
      },
      sources: {
        type: "array",
        description:
          "Complete public HTTP(S) source URLs only. Do not include local snapshot filenames or explanatory prose.",
        items: { type: "string", pattern: "^https?://" },
      },
    },
    required: ["opening", "company", "sources"],
    additionalProperties: false,
  },
};

export function findOpeningByUrl(store: Store, url: string) {
  const identity = canonicalPosting(url);
  const same = (u: string) => {
    try {
      return canonicalPosting(u) === identity;
    } catch {
      return false;
    }
  };
  const openings = store.openings();
  // alternateUrls records other advertisements merged into an existing Opening.
  return (
    openings.find((o) => same(o.url)) ??
    openings.find((o) => (o.alternateUrls ?? []).some(same))
  );
}
export type OpeningMatch = "companyTitle" | "jobId" | "url";
// Cross-source duplicate: the same ATS requisition, or the same normalized
// company and title, among active (not closed/unretained) Openings.
function findDuplicateOpening(
  store: Store,
  input: { url: string; companyNames: string[]; title: string },
): { opening: any; matchedBy: OpeningMatch } | undefined {
  const active = store.openings().filter(isActiveOpening);
  const identity = postingIdentity(input.url);
  if (identity.jobId) {
    const opening = active.find((o) => {
      try {
        return samePostingIdentity(identity, postingIdentity(o.url));
      } catch {
        return false;
      }
    });
    if (opening) return { opening, matchedBy: "jobId" };
  }
  const companies = new Set(
    input.companyNames.map(normalizeCompanyName).filter(Boolean),
  );
  const title = normalizeTitle(input.title);
  const opening = title
    ? active.find(
        (o) =>
          companies.has(normalizeCompanyName(o.company ?? "")) &&
          normalizeTitle(o.title ?? "") === title,
      )
    : undefined;
  return opening ? { opening, matchedBy: "companyTitle" } : undefined;
}
const blank = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && (!v.trim() || v.trim() === "Unknown")) ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === "object" &&
    !Array.isArray(v) &&
    v !== null &&
    !Object.keys(v).length);
// Fields that identify or own the existing record are never replaced by a merge.
const mergeKeep = new Set([
  "id",
  "url",
  "company_id",
  "company",
  "createdAt",
  "firstImportedAt",
  "first_seen",
  "hash",
  "sourcePath",
  "sourceDate",
  "status",
  "assessmentSourceHash",
  "listSummary",
  "listSummarySourceHash",
  "skills",
  "skillsSourceHash",
  "validation",
  "lastCheckedAt",
  "postingStatus",
  "last_confirmed_open",
  "retained",
]);
const normalizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|corporation|corp)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
const officialHost = (url: string) => {
  try {
    const host = postingUrl(url).hostname.replace(/^www\./, "");
    return /(^|\.)(greenhouse.io|ashbyhq.com|lever.co|myworkdayjobs.com|linkedin.com|indeed.com)$/.test(
      host,
    )
      ? ""
      : host;
  } catch {
    return "";
  }
};
function matchCompany(store: Store, data: any) {
  const companies = [
    ...store.list("cache_company"),
    ...store.list("custom_company"),
  ];
  const name = normalizeName(data.name);
  const host = officialHost(data.officialUrl);
  const matches = companies.filter(
    (c) =>
      normalizeName(c.name) === name ||
      (host && officialHost(c.fields?.["Official site"] ?? "") === host),
  );
  if (data.companyId) {
    const selected = companies.find((c) => c.id === data.companyId);
    if (!selected)
      throw new HttpError(422, "Research selected an unknown company");
    // Explicit research can resolve aliases such as Northwind / Northwind Tools.
    if (matches.length && !matches.some((c) => c.id === selected.id))
      throw new HttpError(
        422,
        "Company name/site conflicts with selected employer",
      );
    return selected;
  }
  if (matches.length > 1)
    throw new HttpError(
      422,
      "Multiple companies match; research must specify the correct companyId",
    );
  return matches[0];
}

export function validateOpeningResearch(store: Store, data: any) {
  for (const [record, fields] of [
    [data?.opening, openingFields],
    [data?.company, companyFields],
  ] as const)
    for (const key of fields)
      if (
        !record ||
        typeof record[key] !== "string" ||
        record[key].length > (key === "description" ? 60000 : 8000)
      )
        throw new HttpError(422, `Research needs bounded text for ${key}`);
  if (
    data.opening.listSummary !== undefined &&
    !validOpeningListSummary(data.opening.listSummary)
  )
    throw new HttpError(
      422,
      "listSummary requires single-line location (60), technicalFit (48), wlbOutlook (48) and compensation (80) summaries. Preserve the full fields separately.",
    );
  openingSkillFields.validate(data.opening.skills);
  if (data.opening.assessmentDetails !== undefined) {
    if (!validOpeningAssessmentDetails(data.opening.assessmentDetails))
      throw new HttpError(
        422,
        "assessmentDetails requires nonempty technicalFit, remoteFit and wlbOutlook explanations of at most 8000 characters each.",
      );
    for (const key of assessmentFields)
      if (!isOpeningAssessmentValue(data.opening[key]))
        throw new HttpError(
          422,
          `opening.${key} must be High, Medium, Low, Uncertain or Unknown. Keep full explanations in assessmentDetails.`,
        );
  }
  const dateSources = data.opening.dateSources;
  if (
    dateSources !== undefined &&
    (!dateSources ||
      typeof dateSources !== "object" ||
      Array.isArray(dateSources) ||
      dateFields.some((key) => !(key in dateSources)))
  )
    throw new HttpError(
      422,
      "dateSources requires firstPublishedAt and deadline source URLs, or null for unknown dates.",
    );
  for (const key of dateFields) {
    const date = data.opening[key],
      source = dateSources?.[key];
    if (date !== undefined && !validOpeningDate(date))
      throw new HttpError(
        422,
        `opening.${key} must be a valid YYYY-MM-DD date, an ISO timestamp with timezone, or null.`,
      );
    if (source !== undefined && source !== null) {
      try {
        postingUrl(source);
      } catch {
        throw new HttpError(
          422,
          `opening.dateSources.${key} must be a complete public HTTP(S) URL or null.`,
        );
      }
      if (date === null)
        throw new HttpError(
          422,
          `opening.dateSources.${key} must be null when the date is unknown.`,
        );
    }
    if (typeof date === "string" && (typeof source !== "string" || !source))
      throw new HttpError(
        422,
        `Known opening.${key} requires a verified public HTTP(S) URL in dateSources.${key}.`,
      );
  }
  if (
    !data.opening.title.trim() ||
    !data.company.name.trim() ||
    data.opening.description.trim().length < 100
  )
    throw new HttpError(
      422,
      "Research must establish employer, title and a substantive posting description",
    );
  if (/^https?:\/\//i.test(data.opening.jobId))
    throw new HttpError(
      422,
      "opening.jobId must be the requisition ID, or empty if unknown, never a URL",
    );
  if (!["open", "closed", "unconfirmed"].includes(data.opening.postingStatus))
    throw new HttpError(422, "Invalid posting status");
  for (const key of ["officialUrl", "careersUrl", "contactSourceUrl"]) {
    try {
      postingUrl(data.company[key]);
    } catch {
      throw new HttpError(
        422,
        `company.${key} must be a complete public HTTP(S) URL`,
      );
    }
  }
  if (
    !data.company.contactInfo.trim() ||
    !["address", "partial-address", "url"].includes(data.company.contactType)
  )
    throw new HttpError(
      422,
      "A sourced address or official URL contact is required",
    );
  if (data.company.contactType === "url") postingUrl(data.company.contactInfo);
  if (
    !Array.isArray(data.sources) ||
    !data.sources.length ||
    data.sources.length > 30
  )
    throw new HttpError(422, "Research source URLs required");
  data.sources.forEach((u: string, index: number) => {
    try {
      postingUrl(u);
    } catch {
      throw new HttpError(
        422,
        `sources[${index}] must be a complete public HTTP(S) URL. Remove local filenames and explanatory text from sources; their provenance is already captured in the task snapshot.`,
      );
    }
  });
  matchCompany(store, data.company);
  return data;
}

export function prepareOpeningResearch(store: Store, task: any) {
  const companies = [
    ...store.list("cache_company"),
    ...store.list("custom_company"),
  ].map((c) => ({
    id: c.id,
    name: c.name,
    officialUrl: c.fields?.["Official site"],
    careersUrl: c.fields?.["Careers URL"],
    contactInfo: c.contactInfo,
  }));
  const files: Record<string, string> = {
    "companies.json": JSON.stringify(companies, null, 2),
    "job-posting.txt": `Requested URL: ${task.importUrl}\nCaptured: ${task.posting?.fetchedAt ?? now()}\n${task.posting?.text ?? task.fetchError ?? "Use web search to read the official posting."}`,
    "RESEARCH-INSTRUCTIONS.md": researchFileInstructions(
      store.settings().fitCriteria.technologyExcludeTerms,
    ),
  };
  const resume = store
    .state()
    .documents.find(
      (d) =>
        d.kind === "resume" &&
        d.scope === "general" &&
        d.status === "current" &&
        d.text,
    );
  if (resume) files["resume-context.txt"] = resume.text;
  const sourceHashes = task.greenhousePull
    ? addGreenhouseResearchContext(store, task.greenhousePull, files)
    : {};
  const manifest = {
    taskId: task.id,
    purpose: "opening-research",
    paths: Object.keys(files),
    sourceHashes,
  };
  for (const [file, text] of Object.entries(files))
    atomicWrite(draftPath(store, task.id, file), text);
  atomicWrite(
    draftPath(store, task.id, "context-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const bundle = {
    id: task.id,
    scope: "opening-research",
    paths: manifest.paths,
    sourceHashes,
    artifacts: collectArtifacts(store, task.id),
    version: 1,
  };
  store.put("bundle", task.id, bundle);
  return { bundle, manifest };
}

function publicationTask(store: Store, taskId: string) {
  const task = store.get("task", taskId);
  if (!task)
    throw new MissingRecordError(
      409,
      "task",
      taskId,
      "Research task was removed before publication",
    );
  return task;
}

export function publishOpeningResearch(
  store: Store,
  taskId: string,
  afterPublish?: (opening: any, matchedBy?: OpeningMatch) => void,
) {
  const task = publicationTask(store, taskId);
  const data = validateOpeningResearch(store, task.researchResult);
  publicationPullCandidate(store, task);
  const researchHash = sha256(JSON.stringify(data));
  if (task.openingId && task.publishedResearchHash === researchHash)
    return store.opening(task.openingId);
  const candidate = task.greenhousePull?.candidate as
    { posting?: { text?: string } } | undefined;
  const excluded = excludedTechnology(
    `${data.opening.title}\n${data.opening.description}\n${task.posting?.title ?? ""}\n${task.posting?.text ?? ""}\n${candidate?.posting?.text ?? ""}`,
    researchPublicationFitCriteria(store, task),
  );
  if (excluded && !findOpeningByUrl(store, task.importUrl!))
    throw new HttpError(
      422,
      `This posting mentions ${excluded}, which is excluded by your saved technology preferences. No new Opening was added.`,
    );
  return store.transaction(() => {
    let company = matchCompany(store, data.company);
    const at = now();
    if (!company) {
      company = {
        id: `personal-${randomUUID()}`,
        name: data.company.name.trim(),
        sourcePath: "App-owned employer",
        sourceDate: at,
        addedAt: at,
        personalCompany: true,
        fields: {
          "Official site": data.company.officialUrl,
          "Careers URL": data.company.careersUrl,
          "Industry / product": data.company.description,
          Sources: data.sources.join("\n"),
          "Last researched": at.slice(0, 10),
        },
        text: data.company.description,
        hash: sha256(JSON.stringify(data.company)),
      };
      store.put("custom_company", company.id, company);
      store.put("personal", company.id, {
        id: company.id,
        version: 1,
        monitoring: true,
      });
    }
    const previousContact = store.get("company_contact", company.id);
    if (
      !previousContact ||
      (!task.greenhousePull &&
        (previousContact.contactType === "url" ||
          data.company.contactType !== "url"))
    )
      store.put("company_contact", company.id, {
        companyId: company.id,
        companyName: company.name,
        contactInfo: data.company.contactInfo,
        contactType: data.company.contactType,
        sourceUrl: data.company.contactSourceUrl,
        checkedAt: at,
        notes: "Researched while adding a job posting",
        taskId,
      });
    const o = data.opening;
    const byUrl = findOpeningByUrl(store, task.importUrl!);
    const sameUrl = (u: string) => samePostingUrls(u, task.importUrl!);
    // A follow-up correction to a merged import keeps merging into the same Opening.
    const merged =
      task.matchedBy && task.openingId && store.opening(task.openingId)
        ? {
            opening: store.opening(task.openingId),
            matchedBy: task.matchedBy as OpeningMatch,
          }
        : byUrl && !sameUrl(byUrl.url)
          ? { opening: byUrl, matchedBy: "url" as OpeningMatch }
          : byUrl
            ? undefined
            : findDuplicateOpening(store, {
                url: task.importUrl!,
                companyNames: [company.name, data.company.name],
                title: o.title,
              });
    const prior = merged ? undefined : byUrl;
    const assessmentDetails =
      o.assessmentDetails ??
      Object.fromEntries(
        assessmentFields.map((key) => [key, o[key] || "Unknown"]),
      );
    const opening: any = {
      ...(prior ?? {}),
      id: prior?.id ?? `personal-opening-${randomUUID()}`,
      company_id: company.id,
      company: company.name,
      ...(prior ? {} : { createdAt: at, firstImportedAt: at }),
      title: o.title.trim(),
      job_id: o.jobId,
      url: task.importUrl,
      technical_fit: normalizeOpeningAssessment(o.technicalFit),
      remote_fit: normalizeOpeningAssessment(o.remoteFit),
      wlb_outlook: normalizeOpeningAssessment(o.wlbOutlook),
      assessmentDetails,
      location: o.location || "Unknown",
      compensation: o.compensation || "Unknown",
      why: o.why,
      concerns: o.concerns,
      requirements: o.description,
      description: o.description,
      // These bands drive annual-base filters. Keep nonannual pay in source text, without estimating an annual equivalent.
      salaryBands: salaryBands(o.compensation || "Unknown"),
      wlb_evidence: o.wlbEvidence,
      status: "Added by you",
      postingStatus: o.postingStatus,
      first_seen: prior?.first_seen ?? at.slice(0, 10),
      last_confirmed_open: o.postingStatus === "open" ? at.slice(0, 10) : null,
      first_published: o.firstPublishedAt ?? prior?.first_published ?? null,
      deadline:
        o.deadline !== undefined ? o.deadline : (prior?.deadline ?? null),
      dateSources: {
        firstPublishedAt: o.firstPublishedAt
          ? o.dateSources.firstPublishedAt
          : (prior?.dateSources?.firstPublishedAt ?? null),
        deadline:
          o.deadline !== undefined
            ? (o.dateSources?.deadline ?? null)
            : (prior?.dateSources?.deadline ?? null),
      },
      sourcePath: "App-owned opening",
      sourceDate: at,
      lastCheckedAt: at,
      retained: true,
      personalOpening: true,
      reviewRequired: false,
      assessmentDate: at.slice(0, 10),
      verificationNotes:
        "Researched from the linked official sources. See the saved research conversation for evidence and limitations.",
      sources: data.sources,
      researchTaskId: taskId,
      hash: sha256(JSON.stringify(data)),
      posting: {
        kind: "researched",
        url: task.importUrl,
        text: o.description,
        hash: sha256(o.description),
        capturedAt: at,
      },
    };
    opening.assessmentSourceHash = opening.hash;
    opening.listSummary = {
      ...openingListSummary({
        ...opening,
        listSummary: data.opening.listSummary,
        listSummarySourceHash: undefined,
      }),
      technicalFit: opening.technical_fit,
      wlbOutlook: opening.wlb_outlook,
    };
    opening.listSummarySourceHash = opening.hash;
    openingSkillFields.bind(opening, o.skills);
    if (merged) {
      const { validation: _validation, ...existing } = merged.opening;
      const combined: any = { ...existing };
      for (const [key, value] of Object.entries(opening))
        if (!mergeKeep.has(key) && blank(combined[key]) && !blank(value))
          combined[key] = value;
      if (blank(existing.assessmentDetails))
        combined.assessmentSourceHash = combined.hash;
      if (
        !existing.listSummary ||
        existing.listSummarySourceHash !== existing.hash
      ) {
        combined.listSummary = {
          ...openingListSummary({
            ...combined,
            listSummary: undefined,
            listSummarySourceHash: undefined,
          }),
          technicalFit: combined.technical_fit,
          wlbOutlook: combined.wlb_outlook,
        };
        combined.listSummarySourceHash = combined.hash;
      }
      openingSkillFields.merge(combined, existing, opening);
      Object.assign(combined, {
        personalOpening: true,
        alternateUrls: [
          ...new Set([
            ...(existing.alternateUrls ?? []),
            ...(sameUrl(existing.url) ? [] : [task.importUrl]),
          ]),
        ],
      });
      store.put("custom_opening", combined.id, combined);
      syncCompanyContacts(store);
      store.put("task", taskId, {
        // Publication reloads the same validated opening-research task and cannot change its preset.
        ...(publicationTask(store, taskId) as Extract<
          Task,
          { preset: "opening-research" }
        >),
        openingId: combined.id,
        importStatus: "ready",
        publishedResearchHash: researchHash,
        matchedBy: merged.matchedBy,
      });
      store.journal(
        "opening_merged",
        `Research for ${o.title.trim()} at ${company.name} matched an existing Opening; missing details were merged`,
        combined.id,
        { taskId, matchedBy: merged.matchedBy, url: task.importUrl },
      );
      afterPublish?.(combined, merged.matchedBy);
      return store.opening(combined.id);
    }
    store.put("custom_opening", opening.id, opening);
    syncCompanyContacts(store);
    store.put("task", taskId, {
      // Publication reloads the same validated opening-research task and cannot change its preset.
      ...(publicationTask(store, taskId) as Extract<
        Task,
        { preset: "opening-research" }
      >),
      openingId: opening.id,
      importStatus: "ready",
      publishedResearchHash: researchHash,
    });
    store.journal(
      "opening_added",
      `Added ${opening.title} at ${company.name}`,
      opening.id,
      { taskId },
    );
    afterPublish?.(opening);
    return store.opening(opening.id);
  });
}

export function applicationDate(timezone: string, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
export function startOpeningApplication(store: Store, openingId: string) {
  const opening = store.opening(openingId);
  if (!opening) throw new HttpError(404, "Opening not found");
  const old = store.list("application").find((a) => a.openingId === openingId);
  const at = now();
  const a: import("../shared/types.js").Application = {
    ...(old ?? {
      id: randomUUID(),
      openingId,
      nextAction: "",
      followUp: "",
      contacts: "",
      notes: "",
      documentIds: [],
      packages: [],
      createdAt: at,
    }),
    status: !old || old.status === "considering" ? "preparing" : old.status,
    startedAt: old?.startedAt ?? at,
    applicationDate:
      old?.applicationDate ??
      applicationDate(store.get("settings", "main").timezone),
    employerContactInfo: opening.contactInfo ?? "",
    employerContact: opening.contact,
    version: (old?.version ?? 0) + 1,
    updatedAt: at,
  };
  store.put("application", a.id, a);
  if (!old?.startedAt)
    store.journal(
      "application_started",
      `Started application for ${opening.company} · ${opening.title}`,
      a.id,
      { applicationDate: a.applicationDate },
    );
  return a;
}
