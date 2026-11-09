import type { GreenhouseReviewPrompt } from "../../shared/greenhouse-review-prompt.js";
import type { Task } from "../../shared/task-records.js";
import type { PullCandidate } from "../greenhouse-pull-records.js";
import {
  greenhouseReviewInstructionsFor,
  pullResearchRequest,
} from "../greenhouse-research.js";
import { researchFileInstructions } from "../opening-research-policy.js";
import { now, type Store } from "../storage.js";
import { taskKind } from "../task-kinds/registry.js";
import { purposePolicy } from "../task-kinds/purpose-policies.js";
import { captureGreenhousePolicy } from "./policy.js";
import {
  cardDateMarginText,
  type CapturedGreenhousePolicy,
} from "../../shared/greenhouse-policy.js";
import { tunable } from "../tunables.js";
import {
  captureGreenhouseGuidance,
  greenhouseGuidanceInstructions,
} from "./guidance.js";
import { reviewInputsFile } from "./review-inputs.js";

// These are display substitutions, never a candidate submitted for research.
function placeholderReview(): Task {
  const candidate: PullCandidate = {
    id: "[CANDIDATE_ID]",
    runId: "[PULL_ID]",
    state: "discovered",
    card: {
      id: "[POSTING_ID]",
      board: "[BOARD]",
      company: "[COMPANY]",
      title: "[ROLE_TITLE]",
      url: "[POSTING_URL]",
      firstPublished: null,
    },
  };
  return {
    ...pullResearchRequest(candidate),
    preset: "opening-research",
    id: "[TASK_ID]",
    status: "handoff",
    context: {},
    messages: [],
    version: 1,
    greenhousePull: {
      runId: candidate.runId,
      candidateId: candidate.id,
    },
  };
}

/** Read-only, on demand: no task, bundle, model session or pull is created. */
export function greenhouseReviewPrompt(store: Store): GreenhouseReviewPrompt {
  const task = placeholderReview();
  const kind = taskKind(task.preset);
  const policy = purposePolicy("opening-research");
  const settings = store.settings();
  const guidance = captureGreenhouseGuidance(store);
  const selection = captureGreenhousePolicy(settings, now());
  return {
    sections: [
      { title: "Model instructions", text: kind.instructions(task) },
      { title: "First user message", text: kind.prompt(task) },
      {
        title: "Review instructions · HARVEST-INSTRUCTIONS.md",
        text:
          greenhouseReviewInstructionsFor(selection) +
          greenhouseGuidanceInstructions(guidance),
      },
      {
        title: "Research instructions · RESEARCH-INSTRUCTIONS.md",
        text: researchFileInstructions(selection.technologyExcludeTerms, true),
      },
      {
        title: "Fieldwork tools",
        text: JSON.stringify(kind.tools(task), null, 2),
      },
      { title: "Captured files · read on demand", text: capturedFiles },
      {
        title: "Saved task request · not the first model message",
        text: task.prompt,
      },
      {
        title: "Delivery · reference, not prompt text",
        text: `The first user message above is sent at turn start. The model instructions are supplied separately as Codex developer instructions or appended to Claude Code's system preset. Fieldwork does not have the provider's built-in system prompt, web-search tool schema or runtime-injected context to display.\n\nThe three Fieldwork tool definitions above are the shared schemas. Codex receives dynamic tools; Claude exposes them as mcp__fieldwork__<name>. Hosted web search is ${policy.web_search}; shell, arbitrary filesystem access, external MCP tools, browser operation and delegation are disabled for this task. Captured files are not inlined in the first message: the model reads them through read_job_search_source. A read returns the path, hash and full text.\n\nThis preview uses the currently saved selection policy, guidance, employment scope and exclusion lists, not unsaved edits. A new pull captures those inputs; existing pulls and their retries retain them. Excluded-company additions remain live as an explicit stop control. Runs created before policy capture retain their fixed default rules and live lists. Each new review captures its posting, company context, available resume/dossier and instruction files. Model and effort selection can vary without changing these Fieldwork-authored instructions.\n\n[POSTING_URL], [COMPANY] and [ROLE_TITLE] stand for that candidate's exact values. The saved task request is shown in the conversation and in pull-metrics evidence, but the registry's First user message is what starts the model turn.`,
      },
      {
        title: "Other selection conditions · not prompt text",
        text: screeningReference(
          selection,
          tunable(store, "greenhouse.cardDateMarginDays"),
        ),
      },
    ],
  };
}

const capturedFiles = `Every review exposes these immutable files through read_job_search_source; their contents are not part of the first user message. Instruction files are reproduced in full above. Other file contents vary and are described with placeholders here, not invented evidence.\n\ncontext-manifest.json — [TASK_ID], purpose, allowed file paths and source hashes.\nHARVEST-INSTRUCTIONS.md — the review rules, captured employment scope and saved user guidance shown above.\nRESEARCH-INSTRUCTIONS.md — the research rules and saved technology exclusions shown above.\njob-posting.txt — [POSTING_URL], [CAPTURED_AT] and [OFFICIAL_POSTING_TEXT].\ngreenhouse-candidate.json — [CANDIDATE_CARD], [API_URL], [FETCHED_AT] and [OFFICIAL_API_METADATA]; posting prose is omitted here because job-posting.txt already holds it.\ncompanies.json — [SAVED_COMPANY_CONTEXT]: company IDs, names, official/careers URLs and contact information at review creation.\nresume-context.txt — [CURRENT_GENERAL_RESUME_TEXT], included only when an indexed current general resume has text.\ngithub-evidence.md — [CURRENT_GITHUB_DOSSIER], included only when the source file exists; read only to resolve specific experience questions.\n${reviewInputsFile} — [REVIEW_INPUT_FINGERPRINTS], included when the run and evidence hashes can be recovered, for review-memory provenance.\n\nThe repository's AGENTS.md is not copied into this research bundle. Its applicable rules reach the model only through the Fieldwork-authored instructions shown above.`;

function screeningReference(
  policy: CapturedGreenhousePolicy,
  cardDateMarginDays: number,
) {
  const travel =
    policy.travelCapPercent === null
      ? "Travel exclusion is disabled: no percentage or non-percentage travel cap is applied."
      : `Explicit percentage travel above ${policy.travelCapPercent}% is screened before review, using the upper bound of a range. The review instructions above cover clearly heavier non-percentage travel.`;
  return `These checks happen outside the model prompt; they must not be mistaken for extra instructions sent to every review.

Original Greenhouse first_published must fall within ${policy.freshnessDays} days and not in the future; missing or unusable dates defer. This is checked before review and again before publication. Search cards allow ${cardDateMarginText(cardDateMarginDays)} more (${policy.freshnessDays + cardDateMarginDays} days total) because their dates are less reliable.

Captured technology exclusions apply anywhere in the title or posting, even optional/preferred: ${policy.technologyExcludeTerms.join(", ") || "(none)"}. C# matching includes C sharp/CSharp; .NET matching includes dotnet and ASP.NET.

${travel}
Role-defining languages absent from the resume: ${policy.excludeMissingLanguage ? "excluded under the review rule above" : "not an automatic exclusion"}.

Captured title exclusions: ${policy.titleExcludeTerms.join(", ") || "(none)"}. Plainly non-software title screening is ${policy.titleTriage ? "enabled" : "disabled"}; explicit title exclusions still apply.
Excluded companies/boards at start: ${policy.excludedCompanies.join(", ") || "(none)"}. The captured list is combined with the live list: new company exclusions stop discovered/queued candidates without changing already-started reviews; removing a captured company does not widen this pull.

Regular search terms: ${policy.regularSearchTerms.join(", ")}.
Already-saved postings and requisition aliases are deduplicated. Review reuse is ${policy.reuseReviews ? "enabled" : "disabled"}; when enabled, remembered deferrals expire after ${policy.deferralReuseHours} hours. Reuse requires matching posting, policy, guidance and personal evidence; freshness is screened separately.

Extra search terms, pacing, parallel reviews, lookahead and the pull target control discovery/scheduling; they are not additional review-prompt text.`;
}
