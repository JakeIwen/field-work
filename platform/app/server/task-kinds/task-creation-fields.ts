import { greenhouseReviewInstructionsFor } from "../greenhouse-research.js";
import { greenhouseGuidanceInstructions } from "../opening-pull/guidance.js";
import type { TaskCreationOptions } from "./registry.js";

/** Task fields that come from internal creation options rather than the request body. */
export function creationOptionFields(options: TaskCreationOptions) {
  return {
    ...(options.greenhouseContext
      ? {
          greenhousePull: {
            runId: options.greenhouseContext.run.id,
            candidateId: options.greenhouseContext.candidate.id,
            candidate: options.greenhouseContext.candidate,
            instructions:
              greenhouseReviewInstructionsFor(
                options.greenhouseContext.run.policy,
              ) +
              greenhouseGuidanceInstructions(
                options.greenhouseContext.run.guidance,
              ),
          },
        }
      : {}),
    ...(options.autofillContext
      ? {
          autofillContext: options.autofillContext,
          autofillResult: { status: "drafting" },
        }
      : {}),
    ...(options.preparationContext
      ? {
          preparationId: options.preparationContext.id,
          preparationOpeningHash: options.preparationContext.openingHash,
          preparationPostingHash: options.preparationContext.postingHash,
        }
      : {}),
  };
}
