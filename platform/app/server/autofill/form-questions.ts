import { answersOnlyFinishItem } from "../../shared/greenhouse-autofill.js";
import type { OpeningFormQuestionCounts } from "../../shared/opening-form-check.js";
import type { GreenhouseApi } from "../greenhouse-form.js";
import { buildAutofillPlan } from "../greenhouse-autofill-plan.js";
import type { readAutofillProfile } from "./profile.js";

/** No saved-draft context: estimate only the form and current profile rules. */
export function formQuestionCounts(
  url: string,
  html: string,
  api: GreenhouseApi,
  profile: ReturnType<typeof readAutofillProfile>["profile"],
): OpeningFormQuestionCounts {
  const plan = buildAutofillPlan(url, html, api, profile);
  const draftable = new Set(plan.dynamicQuestions.map((item) => item.label));
  return {
    personal: plan.review
      .filter(answersOnlyFinishItem)
      .filter((item) => !draftable.has(item.label))
      .map(({ label, reason }) => ({ label, reason })),
    narrative: plan.dynamicQuestions.length,
  };
}
