import type { GreenhousePullPolicy } from "../../shared/greenhouse-policy.js";

// Approximation for explaining a percentage, not a claim about an employer’s calendar.
const annualWorkingDays = { low: 220, high: 240 };
const travelExamples = [
  { above: 25, text: "a week per month" },
  { above: 10, text: "monthly multi-day client visits" },
];

export function greenhouseTravelInstructions(
  cap: GreenhousePullPolicy["travelCapPercent"],
) {
  if (cap === null) return "";
  const low = (cap * annualWorkingDays.low) / 100;
  const high = (cap * annualWorkingDays.high) / 100;
  const days = low === high ? `${low}` : `${low}–${high}`;
  const examples = travelExamples
    .filter((example) => cap < example.above)
    .map((example) => example.text);
  // At the historical 5% cap, these qualitative obligations were explicitly disallowed.
  // At larger caps their frequency alone cannot establish the percentage.
  if (cap <= 5)
    examples.push("frequent travel", "regular travel to customer sites");
  const heavier = examples.length
    ? `, including clearly heavier non-percentage requirements such as ${examples.slice(0, -1).join(", ")}${examples.length > 1 ? " or " : ""}${examples.at(-1)}`
    : "; exclude non-percentage requirements only when their stated duration clearly exceeds this cap";
  const occasional =
    cap >= 5
      ? "Occasional or annual team gatherings of a few days, and unstated or vague travel, do not exclude on their own; record them as remote-fit restrictions."
      : `For occasional or annual gatherings, use their stated duration against the ${cap}% cap; do not assume they are exempt. Unstated or vague travel does not establish an exclusion; record it as a remote-fit restriction.`;
  return `Use skip_greenhouse_opening to exclude required travel above ${cap}% of working time (about ${days} working days a year)${heavier}. ${occasional} `;
}

export const greenhouseMissingLanguageInstructions =
  "Use skip_greenhouse_opening when a programming language absent from the languages on the resume defines the role: its title names that language (for example Go Engineer or Senior Rust Developer), or its day-to-day work centers on it (for example a Go-based build tool). Keep roles where the missing language is one of several working languages alongside one on the resume, preferred or nice-to-have, or incidental. ";
