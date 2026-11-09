import { load } from "cheerio";
import type { GreenhouseCard } from "./greenhouse-source.js";
import {
  regularGreenhouseEmploymentTypes,
  greenhouseEmploymentTypeLabels,
  greenhouseSearchIdentity,
  type GreenhouseEmploymentType,
} from "../shared/greenhouse-search.js";
import { validGreenhouseSearchTerm } from "../shared/greenhouse-guidance.js";

export class GreenhouseSearchTransient extends Error {}

export function parseGreenhouseResponse(
  response: { body?: string; bodyTruncated?: boolean; bodyError?: string },
  query: string,
  page: number,
  employmentTypes?: GreenhouseEmploymentType[],
  requestUrl?: string,
) {
  const label = `Greenhouse search “${greenhouseSearchIdentity({ query, employmentTypes }).label}”, page ${page}`;
  if (response.bodyTruncated || response.bodyError || !response.body?.trim()) {
    const reason = response.bodyTruncated
      ? "response exceeded the 1 MB capture limit"
      : response.bodyError
        ? `response body unavailable: ${String(response.bodyError).slice(0, 250)}`
        : "response body was empty";
    throw new GreenhouseSearchTransient(`${label}: ${reason}.`);
  }
  const body = response.body.trim();
  const payload = body.startsWith("{")
    ? body
    : load(body)("[data-page]").first().attr("data-page");
  if (!payload)
    throw new GreenhouseSearchTransient(
      `${label}: page data was not captured.`,
    );
  try {
    const data = JSON.parse(payload);
    if (
      data.component === "jobs" &&
      data.props?.jobPosts === undefined &&
      data.deferredProps &&
      Object.values(data.deferredProps).some(
        (group) => Array.isArray(group) && group.includes("jobPosts"),
      )
    ) {
      responseSearchIdentity(
        data.url,
        query,
        page,
        employmentTypes,
        requestUrl,
      );
      return undefined;
    }
    return parseSearch(payload, query, page, employmentTypes, requestUrl);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GreenhouseSearchTransient(
        `${label}: response JSON was incomplete.`,
      );
    throw error;
  }
}

export function searchUrl(
  query: string,
  page: number,
  employmentTypes: GreenhouseEmploymentType[] = regularGreenhouseEmploymentTypes,
) {
  if (!validGreenhouseSearchTerm(query) || !Number.isInteger(page) || page < 1)
    throw Error("Invalid Greenhouse search");
  if (
    !employmentTypes.length ||
    new Set(employmentTypes).size !== employmentTypes.length ||
    !employmentTypes.every((type) =>
      Object.hasOwn(greenhouseEmploymentTypeLabels, type),
    )
  )
    throw Error("Invalid Greenhouse employment types");
  const u = new URL("https://my.greenhouse.io/jobs/search");
  u.searchParams.set("query", query);
  u.searchParams.set("date_posted", "past_ten_days");
  u.searchParams.append("work_type[]", "remote");
  for (const value of employmentTypes)
    u.searchParams.append("employment_type[]", value);
  u.searchParams.set("page", String(page));
  return u.href;
}
export function parseSearch(
  body: string,
  query: string,
  page: number,
  employmentTypes?: GreenhouseEmploymentType[],
  requestUrl?: string,
) {
  const data = JSON.parse(body),
    p = data.props;
  if (
    data.component !== "jobs" ||
    p?.page !== page ||
    typeof p.moreResultsAvailable !== "boolean" ||
    !Array.isArray(p.jobPosts)
  )
    throw Error(
      "Greenhouse did not return the requested results page. Search remains incomplete.",
    );
  const u = responseSearchIdentity(
    data.url,
    query,
    page,
    employmentTypes,
    requestUrl,
  );
  const cards: GreenhouseCard[] = p.jobPosts.map((j: any) => {
    if (
      !/^\d+$/.test(String(j.id)) ||
      !/^[a-z\d_-]+$/i.test(j.urlToken) ||
      typeof j.title !== "string" ||
      typeof j.companyName !== "string"
    )
      throw Error(
        "Greenhouse returned an unidentified listing. Search remains incomplete.",
      );
    // Use the observed board token and public posting ID, including EU boards.
    const host = String(j.publicUrl).startsWith(
      "https://job-boards.eu.greenhouse.io/",
    )
      ? "job-boards.eu.greenhouse.io"
      : "job-boards.greenhouse.io";
    return {
      id: String(j.id),
      board: j.urlToken,
      title: j.title,
      company: j.companyName,
      url: `https://${host}/${j.urlToken}/jobs/${j.id}`,
      firstPublished: j.firstPublished ?? null,
    };
  });
  return {
    cards,
    ...(employmentTypes ? { employmentTypes: [...employmentTypes] } : {}),
    more: p.moreResultsAvailable as boolean,
    page,
    query,
    url: u.href,
    at: new Date().toISOString(),
    status: 200,
  };
}
export type GreenhousePage = ReturnType<typeof parseSearch>;

function responseSearchIdentity(
  value: unknown,
  query: string,
  page: number,
  employmentTypes: GreenhouseEmploymentType[] | undefined,
  requestUrl?: string,
) {
  // Inertia partial JSON may omit url; only the captured matching request can
  // supply it. If both identities exist they must independently match.
  if (requestUrl !== undefined)
    validateSearchIdentity(requestUrl, query, page, employmentTypes);
  return validateSearchIdentity(
    value === undefined ? requestUrl : value,
    query,
    page,
    employmentTypes,
  );
}

export function validateSearchIdentity(
  value: unknown,
  query: string,
  page: number,
  employmentTypes: GreenhouseEmploymentType[] = regularGreenhouseEmploymentTypes,
) {
  if (typeof value !== "string")
    throw Error(
      "Greenhouse search filters changed. Search remains incomplete.",
    );
  const u = new URL(value, "https://my.greenhouse.io");
  const actualTypes = u.searchParams.getAll("employment_type[]").sort();
  const expectedTypes = [...employmentTypes].sort();
  if (
    u.origin !== "https://my.greenhouse.io" ||
    u.pathname !== "/jobs/search" ||
    u.searchParams.getAll("query").length !== 1 ||
    u.searchParams.get("query") !== query ||
    u.searchParams.getAll("page").length !== 1 ||
    u.searchParams.get("page") !== String(page) ||
    u.searchParams.getAll("date_posted").join() !== "past_ten_days" ||
    u.searchParams.getAll("work_type[]").join() !== "remote" ||
    actualTypes.length !== expectedTypes.length ||
    actualTypes.some((type, index) => type !== expectedTypes[index])
  )
    throw Error(
      "Greenhouse search filters changed. Search remains incomplete.",
    );
  return u;
}
