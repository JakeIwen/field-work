import type { ReplyClassification } from "../../shared/gmail.js";

const clearRejectionPatterns = [
  /\bwe (?:have )?(?:decided|chosen|made (?:the )?(?:difficult )?decision) to (?:move forward with|proceed (?:with|forward with)|pursue|hire|select) (?:other|another) candidates?\b/i,
  /\bwe (?:have )?(?:chosen|selected|hired) (?:other|another) candidates?\b/i,
  /\bwe (?:are|will be) (?:moving|proceeding) forward with (?:other|another) candidates?\b/i,
  /\bwe (?:are not|will not be|won['’]t be|have decided not to)\b.{0,35}\b(?:moving|move|proceed|proceeding|continuing|continue)\b.{0,35}\b(?:your application|your candidacy|with you)\b/i,
  /\b(?:your (?:application|candidacy) (?:has been |was |is )?(?:unsuccessful|rejected|not selected)|you (?:were|have) not (?:been )?(?:selected|shortlisted)|we (?:are )?no longer considering (?:you|your application)|we (?:have )?decided not to (?:move|proceed) forward)\b/i,
];

export function classifyNegativeReply(
  text: string,
): ReplyClassification | null {
  const body = text
    .replace(/\bwe['’]ve\b/gi, "we have")
    .replace(/\bwe['’]re\b/gi, "we are")
    .replace(/\s+/g, " ");
  // Test actual decisions sentence by sentence so hypothetical outcomes and feedback footers stay separate.
  const decisions = body
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        !/\b(?:if|should)\b|\bnot (?:a |an )?rejection\b|\bhave not (?:rejected|made a decision)\b/i.test(
          sentence,
        ),
    );
  const clear = decisions.some((sentence) =>
    clearRejectionPatterns.some((pattern) => pattern.test(sentence)),
  );
  if (clear) {
    const conflictingInvitation =
      /\b(?:invite you|inviting you|please schedule|schedule your)\b.{0,100}\b(?:interview|phone screen)|\b(?:pleased|happy|delighted) to offer you\b/i.test(
        body,
      );
    return {
      kind: conflictingInvitation ? "negative" : "rejection",
      clear: !conflictingInvitation,
    };
  }
  // A cancelled or postponed interview alone does not close the application.
  if (
    /\b(?:interview|call)\b.{0,70}\b(?:reschedul\w*|postpon\w*|cancell?ed)\b|\b(?:reschedul\w*|postpon\w*)\b.{0,70}\b(?:interview|call)\b/i.test(
      body,
    )
  )
    return null;
  if (
    decisions.some((sentence) =>
      /\b(?:position|role|vacancy)\b.{0,30}\b(?:has been filled|was filled|has been closed|has been eliminated|has been cancel(?:l)?ed|is no longer available)\b/i.test(
        sentence,
      ),
    )
  )
    return { kind: "rejection", clear: false };
  if (
    decisions.some((sentence) =>
      /\b(?:hiring|recruitment|recruiting|position|role)\b.{0,50}\b(?:on hold|paused|hiring freeze)|\boffer\b.{0,30}\b(?:withdrawn|rescinded)|\b(?:not moving forward|not proceeding|unable to offer|regret to inform)\b/i.test(
        sentence,
      ),
    )
  )
    return { kind: "negative", clear: false };
  return null;
}
