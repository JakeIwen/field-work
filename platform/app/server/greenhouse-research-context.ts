import { runGreenhousePolicy } from "./opening-pull/policy.js";
import { researchFileInstructions } from "./opening-research-policy.js";
import {
  reviewInputsFile,
  reviewInputVersion,
  greenhouseReviewInputs,
  reviewEvidenceHashes,
} from "./opening-pull/review-inputs.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "../shared/task-records.js";
import { sha256, type Store } from "./storage.js";
import type { PullCandidate } from "./greenhouse-pull-records.js";

type ResearchTask = Extract<Task, { preset: "opening-research" }>;

export function addGreenhouseResearchContext(
  store: Store,
  context: NonNullable<ResearchTask["greenhousePull"]>,
  files: Record<string, string>,
) {
  const candidate = context.candidate as PullCandidate;
  const run = store.get("greenhouse_pull_run", context.runId);
  const policy = runGreenhousePolicy(run, store.settings());
  const posting = candidate.posting;
  if (!posting) throw Error("Captured pull posting is missing");
  // Full API evidence remains in the candidate ledger; prose is in job-posting.txt.
  const { content: _content, ...metadata } = posting.raw;
  files["greenhouse-candidate.json"] = JSON.stringify(
    {
      card: candidate.card,
      posting: {
        apiUrl: posting.apiUrl,
        fetchedAt: posting.fetchedAt,
        raw: metadata,
      },
    },
    null,
    2,
  );
  files["HARVEST-INSTRUCTIONS.md"] = context.instructions ?? "";
  files["RESEARCH-INSTRUCTIONS.md"] = researchFileInstructions(
    policy.technologyExcludeTerms,
    true,
  );
  const dossier = path.join(
    store.root,
    "source_data/github_evidence_dossier.md",
  );
  if (existsSync(dossier))
    files["github-evidence.md"] = readFileSync(dossier, "utf8");
  if (!run) return {};
  try {
    const sourceHashes = reviewEvidenceHashes(store);
    if (files["github-evidence.md"])
      sourceHashes["source_data/github_evidence_dossier.md"] = sha256(
        files["github-evidence.md"],
      );
    const inputs = greenhouseReviewInputs(store, run, candidate, {
      files,
      sourceHashes,
    });
    if (inputs)
      files[reviewInputsFile] = JSON.stringify({
        version: reviewInputVersion,
        inputs,
      });
    return sourceHashes;
  } catch {
    return {};
  }
}
