import { tunable } from "./tunables.js";
import { tunables } from "../shared/tunables.js";
import { savedReviewedAnswer } from "./application-answer-reviews.js";
import { prohibitsGeneratedAnswers } from "./autofill/question-policy.js";
import { resolveSavedDrafts } from "./autofill/saved-answers.js";
import { referralNameNotApplicable } from "./autofill/profile-answers.js";
import {
  autofillLocation,
  skipForPostingCountry,
} from "./autofill/location.js";
import { suggestAutofill, type Field } from "./suggest-autofill-rules.js";
import { Store, HttpError, sha256 } from "./storage.js";
import type {
  AutofillQuestion,
  AutofillRecord,
  AutofillReview,
} from "../shared/greenhouse-autofill.js";
import {
  narrativeQuestion,
  unmatchedQuestion,
  requiresPersonalAcknowledgement,
} from "./application-answers.js";
import { directAutofillRule } from "./autofill/plan-rules.js";
import { isDiscoveryQuestion } from "./autofill/discovery.js";
import { documentPostingHash } from "./preparation-documents.js";
import {
  greenhouseForm,
  type GreenhouseApi,
  type ControlGroup,
} from "./greenhouse-form.js";
type Answer = Field & { value: string; search?: string };
type ChoiceAnswer = Omit<Answer, "kind"> & {
  kind: "checkbox" | "radio";
  groupName: string;
  questionLabel: string;
};

type AutofillProfile = Parameters<typeof suggestAutofill>[1];
type LocationContext = ReturnType<typeof autofillLocation>;
type PlanField = (Answer | ChoiceAnswer) & {
  source?: AutofillRecord["answers"][number]["source"];
  sourcePaths?: string[];
  caveats?: string[];
};

type DirectRule = ReturnType<typeof directAutofillRule>;

function setupPlanRules(
  form: ReturnType<typeof greenhouseForm>,
  api: GreenhouseApi,
  profile: AutofillProfile,
  locationContext: LocationContext,
  company: string,
) {
  const omitted = new Set(
    form.fields
      .filter(
        (f) =>
          !f.required &&
          (referralNameNotApplicable(f.label, profile) ||
            skipForPostingCountry(f.label, locationContext.applicationCountry)),
      )
      .map((f) => f.id),
  );
  const rules = new Map(
    form.fields.map((f) => [
      f.id,
      directAutofillRule(f, api, profile, company),
    ]),
  );
  const groupFields = form.controlGroups.map((group) => ({
    id: group.name,
    label: group.label,
    ...(group.description ? { description: group.description } : {}),
    kind: "select" as const,
    options: group.choices.map((c) => c.label),
    required: group.required,
  }));
  for (const field of groupFields)
    rules.set(field.id, directAutofillRule(field, api, profile, company));
  return { omitted, rules, groupFields };
}

function gatherApplicationQuestions(
  fields: Field[],
  groupFields: Field[],
  omitted: Set<string>,
  url: string,
  profileHash: string,
  api: GreenhouseApi,
  locationContext: LocationContext,
  answerMaxChars: number,
): AutofillQuestion[] {
  if (prohibitsGeneratedAnswers(api.content ?? "")) return [];
  return [...fields, ...groupFields]
    .filter((f) => !omitted.has(f.id))
    .map(
      (f) =>
        narrativeQuestion(f, url, answerMaxChars) ??
        unmatchedQuestion(
          f,
          url,
          profileHash,
          sha256(
            JSON.stringify({
              posting: documentPostingHash(api),
              locationContext,
            }),
          ),
          answerMaxChars,
        ),
    )
    .filter((q) => q !== null);
}

function draftableGreenhouseQuestions(
  questions: AutofillQuestion[],
  groups: ControlGroup[],
  context?: { store: Store; openingId: string },
) {
  const multiple = new Set(
    groups
      .filter((g) => g.choices.some((c) => c.kind === "checkbox"))
      .map((g) => g.name),
  );
  // An existing user-confirmed choice is not a model's arbitrary single choice.
  return questions.filter(
    (q) =>
      !multiple.has(q.id) ||
      (context && savedReviewedAnswer(context.store, context.openingId, q)),
  );
}

const usableDraft = (draft: AutofillQuestion | undefined) =>
  draft && !draft.needsInput && !draft.manualReviewRequired;

function appendFieldAnswers(
  formFields: Field[],
  omitted: Set<string>,
  rules: Map<string, DirectRule>,
  dynamicQuestions: AutofillQuestion[],
  fields: PlanField[],
  review: AutofillReview[],
  company: string,
) {
  for (const field of formFields) {
    if (omitted.has(field.id)) continue;
    const rule = rules.get(field.id) as DirectRule;
    const draft = dynamicQuestions.find((q) => q.id === field.id);
    const answer = draft?.reviewedAt ? undefined : rule.answer;
    const salary = rule.salary;
    if (answer) fields.push({ ...field, ...answer, source: "profile" });
    else if (usableDraft(draft) && draft?.notApplicable && !field.required)
      continue;
    else if (usableDraft(draft) && draft?.answer)
      fields.push({
        ...field,
        value: draft.answer,
        source: draft.reviewedAt ? "user" : "codex",
        sourcePaths: draft.sourcePaths,
        caveats: draft.caveats,
      });
    else
      review.push({
        label: field.label,
        required: field.required,
        reason: draft?.manualReviewRequired
          ? `Manual review required: ${draft.reviewReason}`
          : draft
            ? "This answer has not been prepared yet. Refresh to finish preparation."
            : requiresPersonalAcknowledgement(field)
              ? "Review and acknowledge this declaration yourself on the application form."
              : /\b(salary|compensation)\b/i.test(field.label)
                ? (salary?.reviewReason ??
                  "The requested pay format needs review; your saved rule uses the lowest published pay or its configured fallback.")
                : isDiscoveryQuestion(field.label, company)
                  ? "No unique available choice matches your saved discovery-source preference."
                  : /^zip\s*code\??$/i.test(field.label)
                    ? "Your saved city does not establish a specific ZIP code."
                    : "No confirmed answer for this question and its available options.",
      });
  }
}

function appendControlGroupAnswers(
  controlGroups: ControlGroup[],
  rules: Map<string, DirectRule>,
  dynamicQuestions: AutofillQuestion[],
  fields: PlanField[],
  review: AutofillReview[],
) {
  for (const group of controlGroups) {
    const draft = dynamicQuestions.find((q) => q.id === group.name);
    const answer = draft?.reviewedAt
      ? undefined
      : rules.get(group.name)?.answer;
    const value =
      answer?.value ?? (usableDraft(draft) ? draft?.answer : undefined);
    const index = review.findIndex((q) => q.label === group.label);
    if (usableDraft(draft) && draft?.notApplicable && !group.required) {
      if (index !== -1) review.splice(index, 1);
      continue;
    }
    const choice = value && group.choices.find((c) => c.label === value);
    if (choice) {
      fields.push({
        ...choice,
        questionLabel: group.label,
        groupName: group.name,
        value,
        options: group.choices.map((c) => c.label),
        required: group.required,
        source: answer ? "profile" : draft?.reviewedAt ? "user" : "codex",
        ...(answer
          ? {}
          : { sourcePaths: draft?.sourcePaths, caveats: draft?.caveats }),
      });
      if (index !== -1) review.splice(index, 1);
    } else if (draft && index !== -1)
      review[index] = {
        ...review[index],
        reason: draft.manualReviewRequired
          ? `Manual review required: ${draft.reviewReason}`
          : "This answer has not been prepared yet. Refresh to finish preparation.",
      };
  }
}

export function buildAutofillPlan(
  url: string,
  html: string,
  api: GreenhouseApi,
  profile: AutofillProfile,
  context?: { store: Store; openingId: string },
) {
  const answerMaxChars = context
    ? tunable(context.store, "autofill.answerMaxChars")
    : tunables["autofill.answerMaxChars"].default;
  const form = greenhouseForm(html, api, answerMaxChars);
  const profileHash = sha256(JSON.stringify(profile));
  const locationContext = autofillLocation(api, profile);
  const company = String(api.company_name ?? "");
  const { omitted, rules, groupFields } = setupPlanRules(
    form,
    api,
    profile,
    locationContext,
    company,
  );
  const questions = gatherApplicationQuestions(
    form.fields,
    groupFields,
    omitted,
    url,
    profileHash,
    api,
    locationContext,
    answerMaxChars,
  );
  const { dynamicQuestions, knowledgeHash } = resolveSavedDrafts(
    draftableGreenhouseQuestions(questions, form.controlGroups, context),
    context,
    rules,
  );
  const fields: PlanField[] = [],
    review = [...form.review];
  appendFieldAnswers(
    form.fields,
    omitted,
    rules,
    dynamicQuestions,
    fields,
    review,
    company,
  );
  appendControlGroupAnswers(
    form.controlGroups,
    rules,
    dynamicQuestions,
    fields,
    review,
  );
  if (!fields.length)
    throw new HttpError(422, "No saved answers match this application.");
  return {
    url,
    fields,
    review,
    dynamicQuestions,
    knowledgeHash,
    controlGroups: form.controlGroups,
    requiredFields: form.fields
      .filter((f) => f.required)
      .map((f) => ({ id: f.id, label: f.label })),
  };
}
