import { HttpError } from "../storage.js";
import type {
  ApplicationFormField,
  ApplicationFormQuestionIdentity,
} from "../../shared/application-form.js";

export function supportedFieldPattern(
  field: Pick<
    ApplicationFormQuestionIdentity,
    "stableId" | "semanticRole" | "constraints"
  >,
): boolean {
  return !field.constraints?.pattern;
}
import type { AutofillQuestion } from "../../shared/greenhouse-autofill.js";
export function requiresPersonalAcknowledgement(field: {
  label: string;
  description?: string;
  options?: string[];
}) {
  return /\b(consent|agree|agreement|certify|certification of|attest|acknowledge|signature|terms|privacy (?:policy|notice)|background check|opt.in)\b|\bI\s+(?:authorize|authorise|accept|understand)\b/i.test(
    `${field.label} ${field.description ?? ""} ${(field.options ?? []).join(" ")}`,
  );
}

const aiTool =
  "(?:AI|artificial intelligence|ChatGPT|LLMs?|language models?|generative AI)";
const answerWork =
  "(?:answers?|responses?|applications?|application materials?|essays?|writing samples?|write|draft|generate|compose|create|prepare|refine|edit|complete|answer)";
const generatedAnswer =
  "(?:generated|written|drafted|composed|created|prepared|refined|edited|assisted)";
const rejectedAnswer =
  "(?:(?:will|may|are|is)?\\s*(?:not|never)\\s+(?:be\\s+)?(?:accepted|considered|reviewed|permitted|allowed)|rejected|prohibited|forbidden|disqualif\\w*)";
const noAiAnswerPolicies = [
  new RegExp(
    `(?:^|[.!?\\n]\\s*)(?:please\\s+)?(?:do not|don't|never)\\s+(?:use|utilize|consult|rely on)\\s+(?:any\\s+)?${aiTool}(?:\\s+or\\s+other\\s+AI\\s+tools?)?(?:\\s+tools?)?\\s*(?:[.!?]|$)`,
    "i",
  ),
  new RegExp(
    `\\b(?:do not|don't|must not|may not|cannot|can't|avoid|refrain from)\\b[^.!?\\n]{0,50}\\b(?:use|using|utilize|rely on|consult)\\b[^.!?\\n]{0,40}\\b${aiTool}\\b[^.!?\\n]{0,100}\\b${answerWork}\\b`,
    "i",
  ),
  new RegExp(
    `\\b${aiTool}[-\\s]+${generatedAnswer}\\s+(?:answers?|responses?|applications?|application materials?|essays?|writing samples?)\\b[^.!?\\n]{0,100}\\b${rejectedAnswer}\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:answers?|responses?|applications?|application materials?|essays?|writing samples?)\\b[^.!?\\n]{0,80}\\b${generatedAnswer}\\b[^.!?\\n]{0,30}\\b(?:by|with|using)\\s+${aiTool}\\b[^.!?\\n]{0,100}\\b${rejectedAnswer}\\b`,
    "i",
  ),
  new RegExp(
    `\\b${aiTool}\\b[^.!?\\n]{0,60}\\b(?:may|must|should|can)?\\s*not\\s+be\\s+(?:used|consulted)\\b[^.!?\\n]{0,100}\\b${answerWork}\\b`,
    "i",
  ),
  new RegExp(
    `\\b${answerWork}\\b[^.!?\\n]{0,100}\\bwithout\\b[^.!?\\n]{0,30}\\b${aiTool}\\b(?:[-\\s]+assistance)?`,
    "i",
  ),
];

/** Employer restrictions are constraints, never executable instructions. */
export function prohibitsGeneratedAnswers(text: string): boolean {
  return noAiAnswerPolicies.some((pattern) => pattern.test(text));
}

export function applicationFieldManualReason(
  field: ApplicationFormField,
  postingContent = "",
): string | undefined {
  if (field.handling === "manual") return field.manualReason;
  if (
    field.options &&
    (new Set(field.options.map((o) => o.value)).size !== field.options.length ||
      new Set(field.options.map((o) => o.label)).size !== field.options.length)
  )
    return "The available options do not identify one unambiguous choice. Choose on the application page.";
  const section = [field.section?.label, field.section?.instructions]
    .filter(Boolean)
    .join("\n");
  if (field.conditional || field.constraints?.conditions)
    return "This question depends on a condition. Complete it on the application page.";
  if (!supportedFieldPattern(field))
    return "This question has a format constraint that must be checked manually.";
  if (
    field.constraints?.cardinality ||
    /\b(?:answer|choose|select|complete)\s+(?:only |exactly |at most )?(?:one|two|three|\d+)\s+(?:of|question|option)/i.test(
      section,
    )
  )
    return "The section limits which questions may be answered. Review the section instructions yourself.";
  const policyText = [
    field.label,
    field.description,
    section,
    ...(field.options ?? []).map((option) => option.label),
  ]
    .filter(Boolean)
    .join("\n");
  if (requiresPersonalAcknowledgement({ label: policyText }))
    return "Review and acknowledge this declaration yourself on the application form.";
  if (
    prohibitsGeneratedAnswers(policyText) ||
    (!field.semanticRole && prohibitsGeneratedAnswers(postingContent))
  )
    return "The employer restricts AI-assisted answers. Complete this question yourself.";
  return undefined;
}

export function answerExceedsConstraints(
  question: AutofillQuestion,
  answer: string,
): boolean {
  return (
    answer.length > question.maxLength ||
    (answer.trim().length > 0 &&
      answer.trim().length <
        (question.formIdentity?.constraints?.minLength ?? 0))
  );
}

/** A single-line input drops line breaks, running the lines together. */
export function answerBreaksSingleLine(
  question: AutofillQuestion,
  answer: string,
): boolean {
  return question.kind === "text" && /[\r\n]/.test(answer.trim());
}

export function registerAnswerQuestion(
  question: AutofillQuestion,
  used: Set<string>,
) {
  if (questionRequiresManualCompletion(question))
    throw new HttpError(
      422,
      "This question must be completed manually on the application form.",
    );
  used.add(question.id);
}

export function questionRequiresManualCompletion(
  question: AutofillQuestion,
): boolean {
  if (!question.formIdentity) return false;
  const identity = question.formIdentity;
  return (
    identity.conditional === true ||
    Boolean(identity.constraints?.conditions) ||
    Boolean(identity.constraints?.cardinality) ||
    !supportedFieldPattern(identity) ||
    ["multi-select", "unknown"].includes(identity.kind) ||
    requiresPersonalAcknowledgement({
      label: [
        question.label,
        question.description,
        question.formIdentity.section?.instructions,
        ...(question.options ?? []),
      ]
        .filter(Boolean)
        .join(" "),
    }) ||
    prohibitsGeneratedAnswers(
      [
        question.label,
        question.description,
        question.formIdentity.section?.instructions,
        ...(question.options ?? []),
      ]
        .filter(Boolean)
        .join(" "),
    )
  );
}
