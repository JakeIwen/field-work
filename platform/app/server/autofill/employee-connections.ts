import { words, yesNoAnswer, type ProfileField } from "./profile-answers.js";

// Relationship questions use employmentHistory.knowsCurrentEmployees;
// missing facts must not fall through to unrelated profile answers.

const connection =
  /\bknows? (?:anyone|anybody|someone|somebody|any(?:one)? (?:current )?(?:employees?|staff|people|team members?))\b|\b(?:relatives?|family(?: members?)?|friends?|(?:close )?personal relationships?|related to (?:anyone|anybody|someone|an employee|any (?:current )?employees?)|relationships? with (?:anyone|any (?:current )?employees?|an employee|a current employee))\b/;
const atEmployer =
  /\b(?:work(?:s|ing)? (?:at|for|here)|employed (?:at|by|with|here)|employees? (?:of|at)|current(?:ly)? (?:employees?|employed|work(?:s|ing)?)|know (?:anyone|anybody|someone|somebody) (?:at|from))\b/;
// A conflict-of-interest question about officials, customers or vendors is a
// different declaration, even when it names relatives.
const otherParty =
  /\b(?:government|official|officials|politically|public sector|competitors?|customers?|clients?|vendors?|suppliers?|investors?|board)\b/;

/** A yes/no question about knowing, or being related to, people who work at the
 * employer. Follow-ups asking for names stay with the drafting pass. */
export function isEmployeeConnectionQuestion(label: string): boolean {
  const q = words(label);
  return (
    /^(?:do|does|are|is|have|has)\b/.test(q) &&
    connection.test(q) &&
    atEmployer.test(q) &&
    !otherParty.test(q)
  );
}

export function employeeConnectionAnswer(
  field: ProfileField,
  profile: any,
): { value: string } | null {
  if (
    profile?.employmentHistory?.knowsCurrentEmployees !== false ||
    !isEmployeeConnectionQuestion(field.label)
  )
    return null;
  return yesNoAnswer(field, "No");
}
