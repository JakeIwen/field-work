export type GreenhouseJobPayload = {
  id?: unknown;
  content?: unknown;
  title?: unknown;
  absoluteUrl?: unknown;
  locationName?: unknown;
  internalJobId?: unknown;
};

export type CareersProviderFeed = {
  kind: "greenhouse";
  rows: GreenhouseJobPayload[];
};

export type WorkdayJobPayload = {
  title: unknown;
  externalPath: string;
  bulletFields: unknown[];
  locationsText: unknown;
};

export type WorkdayInventoryPayload = {
  total: number;
  jobPostings: WorkdayJobPayload[];
};

export type WorkdayPostingDetailPayload = {
  jobReqId: unknown;
  jobDescription: unknown;
  title?: unknown;
  location?: unknown;
  additionalLocations: unknown[];
  endDate?: unknown;
};

// JSON-LD JobPosting fields stay unchecked; customJob stringifies each one it reads.
export type StructuredJobPostingPayload = Record<string, unknown>;

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function payloadRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isPayloadRecord(value)) throw Error(`Invalid ${name}`);
  return value;
}

export function payloadProperty(value: unknown, key: string): unknown {
  return isPayloadRecord(value) ? value[key] : undefined;
}

function nestedProperty(value: unknown, key: string, name: string): unknown {
  if (value == null) throw Error(`Invalid ${name}`);
  return payloadProperty(value, key);
}

function optionalArray(value: unknown, name: string): unknown[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw Error(`Invalid ${name}`);
  return value;
}

function greenhouseJob(value: unknown): GreenhouseJobPayload {
  const row = payloadRecord(value, "Greenhouse job row");
  return {
    id: row.id,
    content: row.content,
    title: row.title,
    absoluteUrl: row.absolute_url,
    locationName: payloadProperty(row.location, "name"),
    internalJobId: row.internal_job_id,
  };
}

export function readCareersProviderFeed(
  kind: string,
  value: unknown,
): CareersProviderFeed {
  if (kind !== "greenhouse") throw Error("Unsupported career feed provider");
  const rows = payloadProperty(value, "jobs");
  if (!Array.isArray(rows)) throw Error("Career inventory has no jobs array");
  if (kind === "greenhouse") {
    const total = payloadProperty(payloadProperty(value, "meta"), "total");
    if (total !== undefined && total !== rows.length)
      throw Error("Greenhouse inventory is incomplete");
    return { kind, rows: rows.map(greenhouseJob) };
  }
  throw Error("Unsupported career feed provider");
}

function workdayJob(value: unknown): WorkdayJobPayload {
  const row = payloadRecord(value, "Workday requisition");
  if (typeof row.externalPath !== "string" || !row.title)
    throw Error("Incomplete Workday requisition");
  return {
    externalPath: row.externalPath,
    title: row.title,
    bulletFields: optionalArray(row.bulletFields, "Workday bullet fields"),
    locationsText: row.locationsText || "",
  };
}

export function readWorkdayInventory(value: unknown): WorkdayInventoryPayload {
  const data = payloadRecord(value, "Workday inventory");
  if (
    !Array.isArray(data.jobPostings) ||
    !Number.isInteger(data.total) ||
    typeof data.total !== "number" ||
    data.total < 0
  )
    throw Error("Workday inventory shape is invalid");
  return {
    total: data.total,
    jobPostings: data.jobPostings.map(workdayJob),
  };
}

function workdayPostingDetail(
  detail: Record<string, unknown>,
): WorkdayPostingDetailPayload {
  return {
    jobReqId: detail.jobReqId,
    jobDescription: detail.jobDescription,
    title: detail.title,
    location: detail.location,
    additionalLocations: optionalArray(
      detail.additionalLocations,
      "Workday additional locations",
    ),
    endDate: detail.endDate,
  };
}

export function readOptionalWorkdayPostingDetail(
  value: unknown,
): WorkdayPostingDetailPayload | undefined {
  const detailValue = payloadProperty(value, "jobPostingInfo");
  if (!isPayloadRecord(detailValue)) return undefined;
  if (!detailValue.jobReqId || !detailValue.jobDescription) return undefined;
  return workdayPostingDetail(detailValue);
}

export function readWorkdayPostingDetail(
  value: unknown,
): WorkdayPostingDetailPayload {
  const detail = readOptionalWorkdayPostingDetail(value);
  if (!detail) throw Error("Workday posting detail is incomplete");
  return detail;
}

export function readOptionalGreenhouseJobDetail(
  value: unknown,
): GreenhouseJobPayload | undefined {
  return isPayloadRecord(value) ? greenhouseJob(value) : undefined;
}

export function readGreenhouseJobDetail(value: unknown): GreenhouseJobPayload {
  const job = readOptionalGreenhouseJobDetail(value);
  if (!job) throw Error("Invalid Greenhouse job row");
  return job;
}

export function readStructuredJobPostings(
  value: unknown,
): StructuredJobPostingPayload[] {
  const jobs: StructuredJobPostingPayload[] = [];
  const walk = (entry: unknown): void => {
    if (Array.isArray(entry)) entry.forEach(walk);
    else if (isPayloadRecord(entry)) {
      if ([entry["@type"]].flat().includes("JobPosting")) jobs.push(entry);
      if (entry["@graph"]) walk(entry["@graph"]);
    }
  };
  walk(value);
  return jobs;
}

export function payloadValue(
  value: unknown,
  key: string,
  name: string,
): unknown {
  return nestedProperty(value, key, name);
}
