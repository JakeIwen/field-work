import type { AutofillRecord } from "../shared/greenhouse-autofill.js";
import type {
  AutofillExecutionCodec,
  AutofillPreparationContext,
  PreparedAutofill,
} from "./application-autofill-contract.js";
import { buildAutofillPlan } from "./greenhouse-autofill-plan.js";
import { greenhouseApi } from "./greenhouse-application-adapter.js";
import { greenhouseApiUrl } from "./greenhouse-application-source.js";
import {
  legacyGreenhouseAttachment,
  reviewWithoutAttached,
  savedAttachment,
  savedSourceAttachment,
} from "./autofill/attachments.js";
import { documentPostingHash } from "./preparation-documents.js";

type LegacyGreenhousePlan = ReturnType<typeof buildAutofillPlan>;
type LegacyGreenhouseExecution = Omit<
  LegacyGreenhousePlan,
  "dynamicQuestions" | "knowledgeHash"
> & {
  attachments: ReturnType<typeof legacyGreenhouseAttachment>[];
};

function answerSummary(
  field: LegacyGreenhousePlan["fields"][number],
): AutofillRecord["answers"][number] {
  return {
    label:
      "questionLabel" in field
        ? field.questionLabel
        : field.label.trim() ||
          (typeof field.description === "string"
            ? field.description.trim()
            : ""),
    value: field.value,
    source: field.source,
    sourcePaths: field.sourcePaths,
    caveats: field.caveats,
  };
}

/** Historical helper payloads, question keys and hash inputs must retain their original shapes. */
export function legacyGreenhouseAutofillCodec(
  { source, identity }: AutofillPreparationContext<"greenhouse">,
  plan: LegacyGreenhousePlan,
): AutofillExecutionCodec {
  return {
    sourceHashInput: {
      api: source.postingPayload,
      html: source.applicationHtml,
    },
    evidenceExtras: {
      apiUrl: greenhouseApiUrl(identity),
      api: source.postingPayload,
    },
    package(attachments, attachmentReview) {
      const review = [
        ...reviewWithoutAttached(plan.review, attachments, (attachment) =>
          attachment.kind === "resume"
            ? "Resume/CV"
            : attachment.kind === "cover-letter"
              ? "Cover letter"
              : attachment.label,
        ),
        ...attachmentReview,
      ];
      const {
        dynamicQuestions: _questions,
        knowledgeHash: _knowledge,
        ...execution
      } = plan;
      const payload: LegacyGreenhouseExecution = {
        ...execution,
        review,
        attachments: attachments.map(legacyGreenhouseAttachment),
      };
      return {
        payload,
        review,
        savedAttachments: attachments.flatMap((attachment) =>
          "documentId" in attachment ? [savedAttachment(attachment, true)] : [],
        ),
        sourceAttachments: attachments.flatMap((attachment) =>
          "sourcePath" in attachment ? [savedSourceAttachment(attachment)] : [],
        ),
      };
    },
    evidencePlan: (attachments) => ({ ...plan, attachments }),
  };
}

export function prepareGreenhouseAutofill(
  context: AutofillPreparationContext<"greenhouse">,
): PreparedAutofill {
  const plan = buildAutofillPlan(
    context.source.applicationUrl,
    context.source.applicationHtml,
    greenhouseApi(context.source.postingPayload),
    context.profile,
    { store: context.store, openingId: context.openingId },
  );
  return {
    answers: plan.fields.map(answerSummary),
    review: plan.review,
    dynamicQuestions: plan.dynamicQuestions,
    knowledgeHash: plan.knowledgeHash,
    documentPostingHash: documentPostingHash(
      greenhouseApi(context.source.postingPayload),
    ),
    attachmentRequirements: context.inspection.fileSlots,
    codec: legacyGreenhouseAutofillCodec(context, plan),
  };
}
