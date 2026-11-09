import type { ApplicationAnswer } from "../shared/task-records.js";
import type { AutofillQuestion } from "../shared/greenhouse-autofill.js";
import { HttpError } from "./storage.js";

export type AnswerRejection = {
  fieldId: string;
  label: string;
  reason: string;
};

/** Keep question identity strict; downgrade only field-level validation failures. */
export function partitionApplicationAnswers<T extends ApplicationAnswer>(
  questions: AutofillQuestion[],
  input: unknown,
  limit: number,
  validate: (question: AutofillQuestion, answer: unknown) => T,
) {
  const submitted =
    input && typeof input === "object" && "answers" in input
      ? input.answers
      : undefined;
  if (
    !questions.length ||
    questions.length > limit ||
    !Array.isArray(submitted) ||
    submitted.length !== questions.length
  )
    throw new HttpError(
      422,
      "Return exactly one answer for every captured written question.",
    );
  const byId = new Map<string, unknown>();
  for (const value of submitted) {
    if (
      !value ||
      typeof value !== "object" ||
      !("fieldId" in value) ||
      typeof value.fieldId !== "string" ||
      byId.has(value.fieldId) ||
      !questions.some((question) => question.id === value.fieldId)
    )
      throw new HttpError(422, "Unknown or duplicate question field.");
    byId.set(value.fieldId, value);
  }
  const rejected: AnswerRejection[] = [];
  const answers = questions.map((question) => {
    try {
      return validate(question, byId.get(question.id));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 422) throw error;
      const reason = `Answer validation failed: ${error.message}`.slice(
        0,
        1500,
      );
      rejected.push({ fieldId: question.id, label: question.label, reason });
      // Never retain the rejected declaration or its unvalidated evidence claims.
      return validate(question, {
        fieldId: question.id,
        answer: "",
        needsInput: true,
        manualReviewRequired: true,
        reviewReason: reason,
        caveats: [reason],
        sourcePaths: [],
        profileKeys: [],
      });
    }
  });
  return { answers, rejected };
}
