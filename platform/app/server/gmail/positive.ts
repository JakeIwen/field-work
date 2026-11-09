import type { ReplyClassification } from "../../shared/gmail.js";

const CONDITIONAL =
  /\b(?:if (?:selected|your (?:application|background|qualifications))|should you be selected|only (?:selected|shortlisted) candidates|we (?:will|may) (?:contact|reach out))\b/i;
const RECEIPT =
  /\b(?:application (?:has been |was )?(?:successfully )?(?:received|submitted)|(?:thank you|thanks) for (?:applying|your application)|we(?:(?:'|’)ve| have)? (?:successfully )?received your application|receipt of your application)\b/i;
const BULK_NOISE =
  /\b(?:job alert|jobs? digest|recommended jobs?|new roles? (?:for|matching)|view all jobs|sales demo|product demo|book a demo)\b/i;
const NEGATIVE =
  /\b(?:unfortunately|regret to inform|not (?:be )?moving forward|will not (?:be |move|proceed)|decided (?:not to|to pursue)|position (?:has been )?filled|unable to (?:offer|proceed)|no longer (?:considering|moving|available)|interview.{0,20}cancelled|offer.{0,20}rescinded)\b/i;

export function isGmailBulkNoise(text: string) {
  return BULK_NOISE.test(text);
}

export function isGmailReceipt(text: string) {
  return RECEIPT.test(text);
}

export function isActionableGmailFollowUp(text: string) {
  return /\b(?:send|share|provide|let me know) (?:a few |some |your )?(?:days?|times?|availability|details|information)\b|\b(?:are you free|would you be available|when (?:would you be|are you) (?:free|available))\b|\b(?:calendar|scheduling) (?:invite|link)\b|\buse (?:this|the) link to (?:pick|select|choose|schedule|book) (?:a )?time\b|\b(?:questions?|more information|additional (?:details|information))\b.{0,80}\b(?:application|candidacy|role)\b/i.test(
    text,
  );
}

export function classifyPositiveReply(
  text: string,
): ReplyClassification | null {
  text = text.replace(/\s+/g, " ");
  if (CONDITIONAL.test(text) || NEGATIVE.test(text) || BULK_NOISE.test(text))
    return null;
  if (
    /\b(?:pleased|delighted|happy|excited) to (?:offer|extend (?:you )?an offer)|\b(?:offer of employment|formal (?:job |employment )?offer|offer letter (?:is attached|attached|for you))\b/i.test(
      text,
    )
  )
    return { kind: "offer", clear: true };
  if (
    /\b(?:invite you|inviting you|please schedule|schedule your|please book|book your)\b.{0,100}\b(?:interview|phone screen|recruiter screen)\b|\binterview (?:invitation|confirmation)\b|\b(?:like|love) to (?:schedule|arrange)\b.{0,80}\b(?:interview|call)\b/i.test(
      text,
    )
  )
    return { kind: "interview", clear: true };
  if (
    /\b(?:please complete|invite you to (?:complete|take)|invited to (?:complete|take)|complete the following)\b.{0,100}\b(?:assessment|coding challenge|coding exercise|take.home)\b/i.test(
      text,
    )
  )
    return { kind: "assessment", clear: true };
  if (/\binvitation:\s*interview\s+(?:with|for|at)\b/i.test(text))
    return { kind: "interview", clear: false };
  if (
    /\b(?:interview|phone screen|recruiter screen)\b/i.test(text) &&
    /\b(?:availability|available|schedule|next step|meet with|speak with)\b/i.test(
      text,
    )
  )
    return { kind: "interview", clear: false };
  if (
    /\b(?:assessment|coding challenge|coding exercise|take.home)\b/i.test(
      text,
    ) &&
    /\b(?:complete|invitation|next step|deadline)\b/i.test(text)
  )
    return { kind: "assessment", clear: false };
  if (/\b(?:job offer|offer letter|employment offer)\b/i.test(text))
    return { kind: "offer", clear: false };
  if (
    /\b(?:what|which) (?:days?|times?) (?:work|are best)|\b(?:send|share|provide|let me know) (?:a few |some |your )?(?:days?|times?|availability)\b(?:.{0,80}\b(?:speak|chat|meet|call)\b)?|\bwhen (?:would you be|are you) (?:free|available)\b|\b(?:are you free|would you be available)\b.{0,60}\b(?:chat|call|speak|meet)\b|\b(?:calendar|scheduling) (?:invite|link)\b|\b(?:sent|send) (?:you )?(?:a |the )?calendar invite\b|\buse (?:this|the) link to (?:pick|select|choose|schedule|book) (?:a )?time\b|\b(?:looking forward to|see you (?:on|at|then))\b|\b(?:next steps?|move forward|continue (?:the|our) conversation|chat (?:about|regarding)|connect (?:about|regarding)|speak (?:about|regarding))\b|\b(?:liked|were impressed (?:by|with)) your (?:application|background|experience)\b|\b(?:questions?|more information|additional (?:details|information))\b.{0,80}\b(?:application|candidacy|role)\b/i.test(
      text,
    )
  )
    return { kind: "follow_up", clear: false };
  return null;
}

export function isConditionalOrReceipt(text: string) {
  return CONDITIONAL.test(text) || RECEIPT.test(text);
}
