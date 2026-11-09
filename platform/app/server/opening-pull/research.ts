import type { Task } from "../../shared/task-records.js";
import type { PullCandidate } from "../greenhouse-pull-records.js";
import { HttpError, type Store } from "../storage.js";
import { postingUrl } from "../job-posting.js";
import { pullProvider, pullPostingTitle } from "./contract.js";
import { pullPostingDate } from "./dates.js";
import { validateOpeningResearch } from "../opening-workflow.js";

export function validatePullSkip(
  args: unknown,
  candidate: PullCandidate,
): NonNullable<Task["greenhouseDecision"]> {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(422, "A source-backed skip is required");
  const value = args as Record<string, unknown>;
  if (
    (value.decision !== "excluded" && value.decision !== "deferred") ||
    ["reason", "softwareAssessment", "remoteAssessment", "fitAssessment"].some(
      (key) => {
        const text = value[key];
        return (
          typeof text !== "string" ||
          text.trim().length < 15 ||
          text.length > 8000
        );
      },
    ) ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > 30 ||
    value.sources.some(
      (source) => typeof source !== "string" || !/^https:\/\//.test(source),
    )
  )
    throw new HttpError(
      422,
      "A skip needs bounded, source-backed software, remote and fit assessments plus public source URLs",
    );
  const sources = value.sources as string[];
  sources.forEach(postingUrl);
  if (!candidate.posting || !sources.includes(candidate.posting.apiUrl))
    throw new HttpError(
      422,
      "Include the captured API URL in the skip evidence",
    );
  return {
    decision: value.decision,
    sources,
    reason: String(value.reason),
    softwareAssessment: String(value.softwareAssessment),
    remoteAssessment: String(value.remoteAssessment),
    fitAssessment: String(value.fitAssessment),
  };
}
export function validatePullResearch(
  store: Store,
  args: unknown,
  candidate: PullCandidate,
) {
  const data = validateOpeningResearch(store, args),
    posting = candidate.posting;
  if (!posting) throw new HttpError(409, "Captured posting is missing");
  if (
    !data.opening.assessmentDetails ||
    !data.opening.listSummary ||
    !data.opening.skills ||
    data.opening.postingStatus !== "open" ||
    ["Low", "Unknown"].includes(data.opening.technicalFit) ||
    data.opening.remoteFit === "Low"
  )
    throw new HttpError(
      422,
      "A new pull opening needs a current open posting, evidenced technical/remote viability, full assessments, list summaries and skills.required/skills.preferred technology lists and skills.anyOf requirement groups. Use skip_greenhouse_opening for unsuitable or unresolved roles.",
    );
  if (pullProvider(candidate.card) !== "greenhouse")
    throw new HttpError(409, "Only Greenhouse pull research can be saved");
  if (
    data.opening.title.trim() !== pullPostingTitle(posting).trim() ||
    data.opening.firstPublishedAt !== posting.raw.first_published ||
    data.opening.dateSources?.firstPublishedAt !== posting.apiUrl
  )
    throw new HttpError(
      422,
      "Use the exact captured API title, original first_published and API URL as its date source",
    );
  pullPostingDate(posting);
  if (!data.sources.includes(posting.apiUrl))
    throw new HttpError(
      422,
      "Include the captured official API URL in sources",
    );
  return { ...data, opening: { ...data.opening, description: posting.text } };
}
