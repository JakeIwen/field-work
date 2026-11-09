import { words, yesNoAnswer, type ProfileField } from "./profile-answers.js";

// The saved preferences.recruitingSms opt-in precedes the generic consent
// filter only for recruiting texts. Marketing and bundled consents stay manual.

export function isRecruitingSmsOptIn(field: ProfileField): boolean {
  const q = words(field.label);
  const all = words(
    [field.label, field.description ?? "", ...field.options].join(" "),
  );
  return (
    /\b(?:sms|text messages?|texts|text message updates)\b/.test(q) &&
    /\b(?:opt(?:ing)? in|receive|receiving)\b/.test(q) &&
    /\b(?:recruit\w*|hiring (?:process|team)|interviews?|this (?:role|position|job)|(?:your|my) application)\b/.test(
      q,
    ) &&
    !/\b(?:marketing|promotional|promotions|newsletters?|job alerts?|other (?:roles|positions|opportunities|jobs)|future (?:roles|positions|opportunities|jobs)|privacy|terms|agree|certify|attest|background|signature|record\w*)\b/.test(
      all,
    )
  );
}

export function recruitingSmsAnswer(
  field: ProfileField,
  profile: any,
): { value: string } | null {
  if (
    profile?.preferences?.recruitingSms !== true ||
    !isRecruitingSmsOptIn(field)
  )
    return null;
  return yesNoAnswer(field, "Yes");
}
