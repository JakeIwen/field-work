import { currentApplicationKnowledgeHashes } from "../application-evidence.js";
import type {
  AutofillQuestion,
  AutofillRecord,
} from "../../shared/greenhouse-autofill.js";
import type { Store } from "../storage.js";
import {
  answerKnowledgeHash,
  savedQuestionAnswer,
} from "../application-answers.js";
import { savedReviewedAnswer } from "../application-answer-reviews.js";

export function resolveSavedDrafts(
  candidates: AutofillQuestion[],
  context: { store: Store; openingId: string } | undefined,
  rules: ReadonlyMap<string, { answer?: unknown }>,
) {
  const questions = candidates.filter(
    (q) =>
      !rules.get(q.id)?.answer ||
      (context && savedReviewedAnswer(context.store, context.openingId, q)),
  );
  const knowledgeHash =
    context && questions.length
      ? answerKnowledgeHash(context.store)
      : undefined;
  const dynamicQuestions: AutofillQuestion[] = questions.map((q) => {
    const saved =
      context && knowledgeHash
        ? savedQuestionAnswer(
            context.store,
            context.openingId,
            q,
            knowledgeHash,
          )
        : undefined;
    return {
      ...q,
      ...(saved
        ? {
            answer: saved.answer,
            needsInput: saved.needsInput,
            manualReviewRequired: saved.manualReviewRequired,
            reviewReason: saved.reviewReason,
            answerHash: saved.answerHash,
            sourcePaths: saved.sourcePaths,
            caveats: saved.caveats,
            taskId: saved.taskId,
            profileKeys: saved.profileKeys,
            notApplicable: saved.notApplicable,
            reviewedAt: saved.reviewedAt,
          }
        : {}),
    };
  });
  return { dynamicQuestions, knowledgeHash };
}

export function autofillAnswerValidity(store: Store) {
  let knowledgeHashes: Set<string> | undefined;
  let knowledgeHash: string | undefined;
  return (record: AutofillRecord) => {
    if (!record.knowledgeHash) return true;
    const current = (knowledgeHash ??= answerKnowledgeHash(store));
    if (record.knowledgeHash !== current) {
      knowledgeHashes ??= currentApplicationKnowledgeHashes(store);
      if (!knowledgeHashes.has(record.knowledgeHash)) return false;
    }
    return (record.dynamicQuestions ?? []).every(
      (question) =>
        savedQuestionAnswer(store, record.openingId, question, current)
          ?.answerHash === question.answerHash,
    );
  };
}
