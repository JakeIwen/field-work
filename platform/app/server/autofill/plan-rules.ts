import { requiresPersonalAcknowledgement } from "./question-policy.js";
import { suggestAutofill, type Field } from "../suggest-autofill-rules.js";
import {
  isSalaryQuestion,
  isSalaryRangeEndQuestion,
  salaryExpectation,
  salaryRangeEnd,
  type SalaryPosting,
} from "./salary.js";
import { discoveryAnswer } from "./discovery.js";
import { recruitingSmsAnswer } from "./recruiting-sms.js";
import { standingDeclarationAnswer } from "./declarations.js";

export type AutofillProfile = Parameters<typeof suggestAutofill>[1];
export function directAutofillRule(
  field: Field,
  posting: Pick<SalaryPosting, "content" | "compensation">,
  profile: AutofillProfile,
  company: string,
  discoveryService = "Greenhouse.io",
) {
  const standing =
    recruitingSmsAnswer(field, profile) ??
    standingDeclarationAnswer(field, profile);
  if (standing) return { answer: standing, salary: null };
  if (requiresPersonalAcknowledgement(field))
    return { answer: null, salary: null };
  const salary = isSalaryQuestion(field.label)
    ? salaryExpectation(posting, profile, field)
    : isSalaryRangeEndQuestion(field.label)
      ? salaryRangeEnd(posting, profile, field)
      : null;
  const discovery = discoveryAnswer(
    field.label,
    field.kind === "select" ? field.options : undefined,
    profile,
    discoveryService,
    company,
  );
  const answer = discovery
    ? { value: discovery }
    : salary?.value
      ? { value: salary.value }
      : suggestAutofill(field, profile, company);
  return { answer, salary };
}
