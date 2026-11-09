export const greenhouseReviewPromptPath = "/api/greenhouse/review-prompt";

/** Fieldwork-authored inputs; provider-owned system prompts are not available. */
export type GreenhouseReviewPrompt = {
  sections: { title: string; text: string }[];
};
