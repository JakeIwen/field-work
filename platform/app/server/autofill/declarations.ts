import {
  uniqueOption,
  words,
  yesNoAnswer,
  type ProfileField,
} from "./profile-answers.js";

// Explicit saved privacy, background-check and restrictive-agreement answers
// precede the generic consent filter. Bundled terms, attestations and unrelated
// checks still stay manual.

const privacyNotice =
  /\b(?:privacy (?:policy|notice|statement|disclosure)|data (?:processing|protection))\b/;
const acknowledgement =
  /\b(?:acknowledg\w*|have read|read and|agree|accept|consent|understand|confirm)\b/;
const notPrivacyOnly =
  /\b(?:terms|certif\w*|attest\w*|true (?:and |or )?(?:correct|complete|accurate)|signature|sign|background|drug|arbitration|marketing|newsletters?|sms|text messages?|(?:future|other) (?:roles|positions|opportunities|jobs|openings)|talent (?:community|pool|network)|record\w*|transcri\w*|ai|artificial intelligence|automated|voluntary|demographic\w*)\b/;

const backgroundCheck =
  /\bbackground (?:checks?|screenings?|investigations?)\b/;
const willingness =
  /^(?:if .+? )?(?:would|will|are|do) you (?:be )?(?:able and )?(?:willing|agree|consent|open|comfortable)\b/;
const conditionAcknowledgement =
  /^i understand (?:that )?.*\b(?:offers?|employment)\b.*\bconditional\b/;
const otherCheck =
  /\b(?:drug|substance|alcohol|credit|motor vehicle|driving|mvr|fingerprint\w*|clearance|polygraph|reference checks?)\b/;
const recordQuestion =
  /\b(?:pass|passing|convict\w*|felony|criminal record|authori[sz]e|signature)\b/;

const restrictiveAgreement =
  /\b(?:non ?compet\w*|non ?solicit\w*|restrictive (?:covenants?|agreements?))\b/;
const otherObligation =
  /\b(?:ever|signed|sign|willing|confidential\w*|non ?disclosure|nda|intellectual property|inventions?)\b/;

const affirmative =
  /^(?:yes|i (?:acknowledge|agree|accept|consent|confirm|understand|have read)|acknowledged?|agreed?|accepted|confirmed?)\b/;
/** The form's one affirmative choice, such as "I acknowledge" or "Yes". */
const affirmativeOption = (field: ProfileField) =>
  field.kind === "select"
    ? uniqueOption(
        field.options,
        (o) => affirmative.test(o) && !/\b(?:not|don t|decline|no)\b/.test(o),
      )
    : null;

export function isPrivacyNoticeAcknowledgement(field: ProfileField) {
  const all = words(
    [field.label, field.description ?? "", ...field.options].join(" "),
  );
  // A description that only mentions the privacy policy does not make another
  // question an acknowledgement.
  return (
    privacyNotice.test(words([field.label, ...field.options].join(" "))) &&
    acknowledgement.test(all) &&
    !notPrivacyOnly.test(all)
  );
}

export function isBackgroundCheckWillingness(field: ProfileField) {
  const q = words(field.label);
  const all = words(
    [field.label, field.description ?? "", ...field.options].join(" "),
  );
  return (
    backgroundCheck.test(q) &&
    (willingness.test(q) || conditionAcknowledgement.test(q)) &&
    !otherCheck.test(all) &&
    !recordQuestion.test(words([field.label, ...field.options].join(" ")))
  );
}

export function isRestrictiveAgreementQuestion(label: string) {
  const q = words(label);
  return (
    /^(?:are|do|have|is)\b/.test(q) &&
    restrictiveAgreement.test(q) &&
    !otherObligation.test(q)
  );
}

export function standingDeclarationAnswer(
  field: ProfileField,
  profile: any,
): { value: string } | null {
  if (
    profile?.preferences?.privacyNotices === true &&
    isPrivacyNoticeAcknowledgement(field)
  )
    // An acknowledgement is selected from the form's own choice, never typed.
    return affirmativeOption(field);
  if (
    profile?.preferences?.backgroundCheck === true &&
    isBackgroundCheckWillingness(field)
  )
    return field.kind === "select"
      ? affirmativeOption(field)
      : { value: "Yes" };
  if (
    profile?.employmentHistory?.boundByRestrictiveAgreement === false &&
    isRestrictiveAgreementQuestion(field.label)
  )
    return yesNoAnswer(field, "No");
  return null;
}
