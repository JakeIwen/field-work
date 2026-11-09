// Work authorization and sponsorship answers use the saved profile values,
// not an inferred country-based eligibility decision. The user reviews any
// exceptions before submitting; absent facts remain unanswered.

/** An employer's "(Skip this question if you are applying in Canada or the
 * UK)" note precedes the question it qualifies. */
export const countrySkipNote =
  /^\(skip this question if you are applying (?:to work )?in ([^)]+)\)\s*/i;

export function withoutCountrySkipNote(label: string): string {
  return label.replace(countrySkipNote, "");
}
