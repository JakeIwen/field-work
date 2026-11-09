// Catch-all uploads such as Greenhouse's "Upload anything",
// and uploads that ask for a recommendation letter, use the applicant-supplied letter.
// Portfolio, transcript, writing-sample and similar uploads do not.
const referenceLetterLabels =
  /^(?:upload anything|anything else|(?:additional|other|supporting|supplemental) (?:documents?|files?|attachments?|materials?)|letters? of (?:recommendation|reference)|(?:recommendation|reference) letters?)$/i;

export function referenceLetterSlot(label: string) {
  return referenceLetterLabels.test(
    label
      .replace(/\*/g, "")
      .replace(/\(optional\)/i, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}
