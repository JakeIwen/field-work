import { tunable } from "../tunables.js";
import { savedReviewedAnswer } from "../application-answer-reviews.js";
import { currentApplicationKnowledgeHashes } from "../application-evidence.js";
import {
  readAutofillEvidence,
  evidencePosting,
  evidenceRuleFacts,
} from "../autofill/evidence.js";
import { questionRequiresManualCompletion } from "../autofill/question-policy.js";
import { sameHostedApplication } from "../../shared/application-host.js";
import type { Task, TaskStatus } from "../../shared/types.js";
import { answerKnowledgeHash } from "../application-answers.js";
import { readAutofillProfile } from "../autofill/profile.js";
import { autofillLocation } from "../autofill/location.js";
import { HttpError, type Store } from "../storage.js";
import type { TaskCreationBody, TaskCreationOptions } from "./registry.js";

// Retain the existing loose record and question boundaries from the producer.
type AutofillRecord = any;
type AutofillQuestionRecord = any;
type AutofillEvidence = ReturnType<typeof JSON.parse>;

export type AutofillAnswerServices = {
  store: Store;
  taskActive: (task: {
    status?: TaskStatus;
    documentResult?: { status: string };
  }) => boolean;
  createTask: (
    body: TaskCreationBody,
    options?: TaskCreationOptions,
  ) => Promise<Task | undefined>;
};

export async function startAutofillAnswers(
  services: AutofillAnswerServices,
  record: AutofillRecord,
  regenerate = false,
) {
  const questions = (record.dynamicQuestions ?? []).filter(
    (question: AutofillQuestionRecord) =>
      !questionRequiresManualCompletion(question) &&
      !savedReviewedAnswer(services.store, record.openingId, question) &&
      (regenerate || !question.taskId),
  );
  if (!questions.length) return null;
  const active = services.store
    .list("task")
    .find(
      (task) =>
        task.autofillContext &&
        task.context?.openingId === record.openingId &&
        (services.taskActive(task) || task.autofillResult?.status === "saving"),
    );
  if (active) return active;
  const maxApplicationQuestions = tunable(
    services.store,
    "autofill.maxQuestions",
  );
  if (questions.length > maxApplicationQuestions)
    throw new HttpError(
      422,
      `This form has more than ${maxApplicationQuestions} unresolved questions. Review or answer some individually before retrying.`,
    );
  if (
    !currentApplicationKnowledgeHashes(services.store).has(record.knowledgeHash)
  )
    throw new HttpError(
      409,
      "Your evidence changed. Generate a new script before drafting answers.",
    );
  const evidence = readAutofillEvidence(services.store, record);
  const opening = services.store.opening(record.openingId);
  if (
    !opening ||
    evidence.plan?.url !== record.url ||
    !sameHostedApplication(opening.url, record.url)
  )
    throw new HttpError(409, "The saved form no longer matches this opening.");
  const matchingProfile = questions.some(
    (question: AutofillQuestionRecord) => question.mode === "unmatched",
  )
    ? readAutofillProfile(services.store)
    : null;
  if (matchingProfile && matchingProfile.hash !== record.profileHash)
    throw new HttpError(
      409,
      "Your saved profile changed. Generate a new script before interpreting unmatched questions.",
    );
  const context = buildAutofillContext(
    record,
    questions,
    evidence,
    matchingProfile,
  );
  context.knowledgeHash = answerKnowledgeHash(services.store);
  return services.createTask(
    {
      preset: "questions",
      mode: "live",
      prompt: `Resolve ${questions.length} application question${questions.length === 1 ? "" : "s"} for ${opening.company}: ${record.title}. Use application-questions.json, confirmed-profile.json when present, and the captured evidence. Interpret unmatched wording, select only actual offered choices, and draft narrative answers where requested. Flag missing facts and genuinely ambiguous answers for manual review; do not invent personal declarations, experience, or measurable effects.`,
      context: { openingId: opening.id, companyId: opening.company_id },
      postingLabel: `${opening.company} ${record.title}`.slice(0, 150),
    },
    { autofillContext: context },
  );
}

export function buildAutofillContext(
  record: AutofillRecord,
  questions: AutofillQuestionRecord[],
  evidence: AutofillEvidence,
  matchingProfile: ReturnType<typeof readAutofillProfile> | null,
) {
  const locationContext = autofillLocation(
    evidenceRuleFacts(evidence),
    matchingProfile?.profile ?? evidence.profile,
  );
  return {
    scriptId: record.id,
    recordId: record.id,
    url: record.url,
    openingHash: record.openingHash,
    sourceHash: record.sourceHash,
    knowledgeHash: record.knowledgeHash,
    postingCountry: locationContext.applicationCountry,
    locationContext,
    ...(matchingProfile
      ? {
          profileHash: matchingProfile.hash,
          profileSnapshot: matchingProfile.profile,
        }
      : {}),
    questions: questions.map(
      ({
        id,
        label,
        kind,
        required,
        maxLength,
        key,
        mode,
        options,
        profileOnly,
        description,
        formIdentity,
      }: AutofillQuestionRecord) => ({
        id,
        label,
        kind,
        required,
        maxLength,
        key,
        mode,
        options,
        profileOnly,
        description,
        formIdentity,
      }),
    ),
    posting: evidencePosting(record, evidence),
  };
}
