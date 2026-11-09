import {
  unmatchedQuestion,
  validateApplicationAnswers,
} from "../../server/application-answers.js";

/** Validates one model draft for a profile question the way the answer task's
 * save tool does, returning the accepted answer or throwing its rejection. */
export function validateProfileDraft(
  field: {
    label: string;
    kind: "text" | "textarea" | "select";
    options?: string[];
  },
  profile: unknown,
  answer: string,
  profileKeys: string[],
) {
  const question = unmatchedQuestion(
    { id: "q", required: true, options: [], ...field },
    "https://job-boards.greenhouse.io/example/jobs/123",
    "profile",
  )!;
  const task: any = {
    manifest: { paths: ["confirmed-profile.json"] },
    autofillContext: { questions: [question], profileSnapshot: profile },
  };
  return validateApplicationAnswers(task, {
    answers: [
      {
        fieldId: "q",
        answer,
        needsInput: false,
        sourcePaths: ["confirmed-profile.json"],
        profileKeys,
        caveats: [],
        manualReviewRequired: false,
        reviewReason: "",
      },
    ],
  })[0].answer;
}
