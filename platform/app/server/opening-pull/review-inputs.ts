import { readFileSync } from "node:fs";
import {
  applicationEvidencePaths,
  applicationEvidenceHash,
} from "../application-evidence.js";
import { safeSource, sha256, type Store } from "../storage.js";
import {
  openingResearchInstructions,
  scopedToolInstructions,
  researchPrompt,
  researchFileInstructions,
} from "../opening-research-policy.js";
import { runGreenhousePolicy } from "./policy.js";
import { greenhouseReviewInstructionsFor } from "../greenhouse-research.js";
import { greenhouseGuidanceInstructions } from "./guidance.js";
import type { Task } from "../../shared/task-records.js";
import type { PullCandidate, PullRun } from "../greenhouse-pull-records.js";

export const reviewInputVersion = "1";
export const reviewInputsFile = "greenhouse-review-inputs.json";
const inputNames = [
  "postingContent",
  "guidance",
  "harvestInstructions",
  "researchInstructions",
  "developerInstructions",
  "promptTemplate",
  "applicationEvidence",
  "resumeContext",
  "fitCriteria",
] as const;
export type ReviewInputs = Record<(typeof inputNames)[number], string>;

function normalized(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    );
  return value;
}

export function reviewPostingHash(candidate: PullCandidate) {
  if (!candidate.posting) return undefined;
  const {
    id: _id,
    internal_job_id: _internal,
    updated_at: _updated,
    first_published: _published,
    absolute_url: _url,
    content: _content,
    ...metadata
  } = candidate.posting.raw;
  // Advertisement identities and fetch/publication clocks are screened separately;
  // all substantive API metadata (including locations/offices) remains decision evidence.
  return sha256(
    JSON.stringify(
      normalized({
        company: candidate.card.company,
        title: candidate.card.title,
        postingTitle: candidate.posting.title,
        metadata,
        body: candidate.posting.text,
      }),
    ),
  );
}

export function reviewEvidenceHashes(store: Store) {
  return Object.fromEntries(
    applicationEvidencePaths.map((relative) => [
      relative,
      sha256(readFileSync(safeSource(store.root, relative))),
    ]),
  );
}

export function greenhouseReviewInputs(
  store: Store,
  run: Pick<PullRun, "guidance" | "policy">,
  candidate: PullCandidate,
  captured?: {
    files: Record<string, string>;
    sourceHashes: Record<string, string>;
  },
): ReviewInputs | undefined {
  try {
    const policy = runGreenhousePolicy(run, store.settings());
    const postingContent = reviewPostingHash(candidate);
    const applicationEvidence = applicationEvidenceHash(
      captured?.sourceHashes ?? reviewEvidenceHashes(store),
    );
    if (!postingContent || !applicationEvidence) return undefined;
    // The registry prompt's only variable is the URL, already represented by identity.
    const task = {
      preset: "opening-research",
      importUrl: "<posting-url>",
      greenhousePull: {},
    } as Task;
    const resume = captured
      ? captured.files["resume-context.txt"]
      : [
          ...store.list("cache_document"),
          ...store.list("generated_document"),
        ].find(
          (d) =>
            d.kind === "resume" &&
            d.scope === "general" &&
            d.status === "current" &&
            d.text,
        )?.text;
    return {
      postingContent,
      guidance: sha256(run.guidance?.instructions ?? ""),
      // Travel and language policy live in the captured instruction text; technology
      // exclusions below share the same snapshot. Freshness is screened separately.
      harvestInstructions: sha256(
        captured?.files["HARVEST-INSTRUCTIONS.md"] ??
          greenhouseReviewInstructionsFor(policy) +
            greenhouseGuidanceInstructions(run.guidance),
      ),
      researchInstructions: sha256(
        captured?.files["RESEARCH-INSTRUCTIONS.md"] ??
          researchFileInstructions(policy.technologyExcludeTerms, true),
      ),
      developerInstructions: sha256(
        openingResearchInstructions + scopedToolInstructions,
      ),
      promptTemplate: sha256(researchPrompt(task)),
      applicationEvidence,
      resumeContext: sha256(resume ?? ""),
      fitCriteria: sha256(JSON.stringify(policy.technologyExcludeTerms)),
    };
  } catch {
    // Missing source evidence disables memory, never substitutes today's facts for a snapshot.
    return undefined;
  }
}

export const reviewFingerprint = (inputs: ReviewInputs) =>
  sha256(
    JSON.stringify([
      reviewInputVersion,
      ...inputNames.map((name) => [name, inputs[name]]),
    ]),
  );

export function recoverReviewInputs(
  store: Store,
  task: Task,
): ReviewInputs | undefined {
  const artifact = task.bundle?.artifacts?.find(
    (item) => item.path === reviewInputsFile,
  );
  if (!artifact) return undefined;
  try {
    const bytes = readFileSync(store.objectPath(artifact.hash));
    if (sha256(bytes) !== artifact.hash) return undefined;
    const snapshot = JSON.parse(bytes.toString("utf8")) as {
      version?: unknown;
      inputs?: ReviewInputs;
    };
    const inputs = snapshot.inputs;
    if (
      snapshot.version !== reviewInputVersion ||
      !inputs ||
      inputNames.some((name) => !/^[a-f0-9]{64}$/.test(inputs[name] ?? ""))
    )
      return undefined;
    return applicationEvidenceHash(task.manifest?.sourceHashes) ===
      inputs.applicationEvidence &&
      applicationEvidenceHash(task.bundle?.sourceHashes) ===
        inputs.applicationEvidence
      ? inputs
      : undefined;
  } catch {
    return undefined;
  }
}
