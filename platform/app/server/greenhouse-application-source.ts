import type { CareersFetch } from "./careers/http.js";
import { HttpError, now } from "./storage.js";
import {
  readableGreenhousePage,
  settledGreenhousePages,
} from "./autofill/fetch.js";
import { greenhousePosting } from "../shared/greenhouse-autofill.js";
import type { GreenhouseHostedApplication } from "../shared/application-host.js";
import type { ApplicationAutofillInspectionSource } from "./application-autofill-contract.js";
import type { GreenhouseApi } from "./greenhouse-form.js";
import { canonicalPosting } from "./job-posting.js";
type CareersPage = Awaited<ReturnType<CareersFetch>>;
type PostingIdentity = NonNullable<ReturnType<typeof greenhousePosting>>;
const text = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 2000
    ? v.trim()
    : null;

function parseGreenhousePages(
  results: PromiseSettledResult<CareersPage>[],
  apiUrl: string,
  jobId: string,
) {
  const [apiPage] = settledGreenhousePages([results[0]]);
  // An employer may deny server reads even though its Greenhouse form is
  // public. Keep that response only for redirect verification below.
  const htmlResult = results[1];
  const htmlPage =
    htmlResult.status === "fulfilled" && htmlResult.value.status === 403
      ? htmlResult.value
      : settledGreenhousePages([htmlResult])[0];
  if (
    new URL(apiPage.url).origin !== "https://boards-api.greenhouse.io" ||
    apiPage.url !== apiUrl
  )
    throw new HttpError(
      422,
      "Greenhouse redirected to a different posting. Open and verify the application first.",
    );
  let api: GreenhouseApi;
  try {
    api = JSON.parse(apiPage.text);
  } catch {
    throw new HttpError(
      422,
      "Greenhouse returned an unreadable question list.",
    );
  }
  if (
    !api ||
    typeof api !== "object" ||
    Array.isArray(api) ||
    String(api.id) !== jobId ||
    !text(api.title)
  )
    throw new HttpError(422, "Greenhouse returned a different or invalid job.");
  return { api, htmlPage };
}

// Employer sites commonly move their documented apex URL to www (or back);
// the path and the gh_jid identity must still match exactly.
function sameDocumentedPosting(actual: string, documented: string) {
  const site = (value: string) => {
    const url = new URL(canonicalPosting(value));
    url.hostname = url.hostname.replace(/^www\./, "");
    return url.href;
  };
  return site(actual) === site(documented);
}

function requiresDirectGreenhouseForm(
  htmlPage: CareersPage,
  posting: PostingIdentity,
  api: GreenhouseApi,
) {
  if (greenhousePosting(htmlPage.url)?.url === posting.url) return false;
  // Custom career sites are a normal Greenhouse integration. Trust only the
  // exact redirect documented by this verified job's public API response.
  let officialRedirect = false;
  try {
    // The documented employer URL may itself upgrade HTTP or move paths.
    // Trust the first employer hop captured by our guarded HTTP reader; only
    // Greenhouse's direct form is ever used for the resulting application.
    const employerHop = htmlPage.redirects?.find(
      (url) => !greenhousePosting(url),
    );
    officialRedirect =
      !greenhousePosting(htmlPage.url) &&
      typeof api.absolute_url === "string" &&
      sameDocumentedPosting(employerHop ?? htmlPage.url, api.absolute_url);
  } catch {
    /* Unverified redirect. */
  }
  if (!officialRedirect)
    throw new HttpError(
      422,
      "Greenhouse redirected to a different posting. Open and verify the application first.",
    );
  return true;
}

export const greenhouseApiUrl = (posting: GreenhouseHostedApplication) =>
  `https://boards-api.greenhouse.io/v1/boards/${posting.board}/jobs/${posting.jobId}?questions=true&pay_transparency=true`;

export async function loadGreenhouseApplication(
  identity: GreenhouseHostedApplication,
  read: CareersFetch,
): Promise<ApplicationAutofillInspectionSource<"greenhouse">> {
  const apiUrl = greenhouseApiUrl(identity);
  const results = await Promise.allSettled([
    read(apiUrl),
    read(identity.applicationUrl),
  ]);
  const parsed = parseGreenhousePages(results, apiUrl, identity.jobId);
  const api = parsed.api;
  let htmlPage = parsed.htmlPage;
  if (requiresDirectGreenhouseForm(htmlPage, identity, api)) {
    const directUrl = `https://job-boards.greenhouse.io/embed/job_app?for=${identity.board}&token=${identity.jobId}`;
    try {
      htmlPage = readableGreenhousePage(await read(directUrl));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        422,
        "Could not read the direct Greenhouse application form. Your saved scripts are unchanged; try again later.",
      );
    }
    if (greenhousePosting(htmlPage.url)?.applicationUrl !== directUrl)
      throw new HttpError(
        422,
        "The direct Greenhouse form redirected unexpectedly. No script was saved.",
      );
  }
  htmlPage = readableGreenhousePage(htmlPage);
  const applicationUrl = greenhousePosting(htmlPage.url)?.applicationUrl;
  if (!applicationUrl)
    throw new HttpError(
      422,
      "The Greenhouse application URL could not be verified.",
    );
  return {
    identity,
    postingPayload: api,
    applicationUrl,
    applicationHtml: htmlPage.text,
    capturedAt: now(),
  };
}
