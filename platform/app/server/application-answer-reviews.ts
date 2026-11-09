import { sameHostedApplication } from "../shared/application-host.js";
import {
  type ApplicationAnswerReview,
  type AutofillQuestion,
  type AutofillQuestionIdentity,
} from "../shared/greenhouse-autofill.js";
import { HttpError, sha256, type Store } from "./storage.js";

export function questionIdentity(
  question: AutofillQuestionIdentity,
): AutofillQuestionIdentity {
  return {
    id: question.id,
    label: question.label,
    kind: question.kind,
    required: question.required,
    maxLength: question.maxLength,
    description: question.description ?? "",
    options: question.options ?? [],
    ...(question.formIdentity ? { formIdentity: question.formIdentity } : {}),
  };
}

function reviewContext(store: Store, review: ApplicationAnswerReview) {
  if (review.url && review.question)
    return { url: review.url, question: review.question };
  const task = store.taskSummaries(review.taskId)[0];
  const context =
    task?.context.openingId === review.openingId
      ? task.autofillContext
      : undefined;
  return {
    url: review.url ?? context?.url,
    question:
      review.question ?? context?.questions.find((q) => q.key === review.key),
  };
}

export function savedReviewedAnswer(
  store: Store,
  openingId: string,
  question: AutofillQuestion,
) {
  const postingUrl = store.opening(openingId)?.url ?? "";
  const identity = JSON.stringify(questionIdentity(question));
  const reviews = store
    .list("application_answer_review")
    .filter((review) => review.openingId === openingId)
    .reverse()
    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
  for (const review of reviews) {
    const saved = reviewContext(store, review);
    if (
      !sameHostedApplication(postingUrl, saved.url ?? "") ||
      !saved.question ||
      JSON.stringify(questionIdentity(saved.question)) !== identity ||
      !review.answer.trim() ||
      review.answer.length > question.maxLength ||
      (question.kind === "select" && !question.options?.includes(review.answer))
    )
      continue;
    // User-confirmed text is authoritative for this exact question, independent of later AI drafts.
    return {
      key: question.key,
      fieldId: question.id,
      taskId: review.taskId,
      answer: review.answer,
      notApplicable: false,
      needsInput: false,
      manualReviewRequired: false,
      reviewReason: "",
      sourcePaths: [],
      caveats: [],
      draftHash: review.draftHash,
      reviewedAt: review.reviewedAt,
      answerHash: sha256(
        JSON.stringify({
          identity,
          answer: review.answer,
          reviewedAt: review.reviewedAt,
        }),
      ),
    };
  }
  return undefined;
}

export function questionForReview(
  store: Store,
  openingId: string,
  taskId: string,
  key: string,
  scriptId: unknown,
) {
  if (scriptId !== undefined) {
    if (typeof scriptId !== "string")
      throw new HttpError(400, "Invalid script ID.");
    const record = store.get("application_autofill", scriptId);
    const opening = store.opening(openingId);
    const question = record?.dynamicQuestions?.find(
      (q) => q.key === key && q.taskId === taskId,
    );
    if (!question || record?.openingId !== openingId)
      throw new HttpError(404, "Application answer not found");
    // The user's answer belongs to the question's exact identity, so a script made
    // stale by later Opening, profile or evidence changes can still take it.
    // Only the user's own later answer to the same question outdates this view of it.
    if (!sameHostedApplication(opening?.url ?? "", record?.url ?? ""))
      throw new HttpError(
        409,
        "The application URL changed. Generate a current script before editing its answers.",
      );
    // A script built after a review always shows it, so a latest review this
    // script does not show was saved after it (timestamps can tie).
    const latest = savedReviewedAnswer(store, openingId, question);
    if (latest && latest.reviewedAt !== question.reviewedAt)
      throw new HttpError(
        409,
        "This answer changed after the script was saved. Reload and review the current answer.",
      );
    return { question, url: record.url, draftHash: question.answerHash ?? "" };
  }
  const task = store.get("task", taskId);
  const context = task?.autofillContext;
  const question = context?.questions.find((q) => q.key === key);
  if (!question || !context || task?.context.openingId !== openingId)
    throw new HttpError(404, "Application answer not found");
  if (!sameHostedApplication(store.opening(openingId)?.url ?? "", context.url))
    throw new HttpError(
      409,
      "The opening changed. Generate a current script before editing its answers.",
    );
  return { question, url: context.url, profileHash: context.profileHash };
}
