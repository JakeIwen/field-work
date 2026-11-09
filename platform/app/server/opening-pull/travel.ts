import { defaultGreenhousePullPolicy } from "../../shared/greenhouse-policy.js";

export const pullTravelLimitPercent =
  defaultGreenhousePullPolicy.travelCapPercent;

const travelWord = String.raw`\btravel(?:l?ing)?\b`;
const percentage = String.raw`(?:(?<!no )(?<!not )\b(?<comparison>more than|greater than|over)\s+)?(?<![\d.])(?<lower>\d{1,3}(?:\.\d+)?)(?:\s*(?:%|percent)?\s*(?:[-–—]|to|and)\s*(?<upper>\d{1,3}(?:\.\d+)?))?\s*(?:%|percent\b)`;
const time = String.raw`(?:of\s+)?(?:(?:the|your|working|work)\s+){0,2}time`;
const travelPercentages = [
  new RegExp(
    String.raw`${percentage}\s+(?:${time}\s+)?(?:(?:spent\s+)?(?:on|in|for)\s+|spent\s+)?(?:(?:domestic|international|business|overnight|and)\s+){0,4}${travelWord}(?!\s+(?:costs?|expenses?|budgets?|industry|bookings?|revenue|savings?|discounts?|allowances?|reimbursement|insurance|software|platform|products?)\b)`,
    "gi",
  ),
  new RegExp(
    String.raw`${travelWord}\s*(?:(?:requirements?|required|expected|expectations?)\s*)?[:(–—-]?\s*(?:(?:is|are|required|expected|to be|will be|may be|will comprise|comprises|will involve|involves|accounts for|represents|of|for|at|approximately|about|roughly|typically|up to|less than|under|between|as much as|at least|no more than|not more than|not to exceed|a maximum of)\s+)*${percentage}(?!\s+(?:cheaper|faster|slower|off|less|more|reduction|savings?|discounts?)\b)(?!\s+of\s+(?!(?:(?:the|your|working|work)\s+){0,2}time\b))`,
    "gi",
  ),
];
const optionalTravel =
  /\b(?:optional|voluntary)\s+travel\b|\b(?:opportunit(?:y|ies)|option) to travel\b|\btravel\b.{0,40}\b(?:optional|voluntary|not required)\b|\bno (?:required )?travel\b/i;

/** Match a travel-time amount, not merely a percentage near a travel noun. */
export function pullTravelExclusion(
  text: string,
  travelCapPercent = pullTravelLimitPercent,
): string | undefined {
  if (travelCapPercent === null) return undefined;
  // Keep sentence/clause boundaries so unrelated pay or business metrics cannot attach to travel.
  const clauses = text.split(/(?<=[.!?])\s+|[,;\n]+/);
  for (const clause of clauses) {
    const fragment = clause.replace(/\s+/g, " ").trim();
    if (optionalTravel.test(fragment)) continue;
    for (const pattern of travelPercentages) {
      for (const match of fragment.matchAll(pattern)) {
        const bounds = [Number(match.groups?.lower)];
        if (match.groups?.upper) bounds.push(Number(match.groups.upper));
        if (
          bounds.every((bound) => bound >= 0 && bound <= 100) &&
          (Math.max(...bounds) > travelCapPercent ||
            (match.groups?.comparison && bounds[0] === travelCapPercent))
        )
          return `Required travel exceeds the ${travelCapPercent}% pull limit: “${fragment}”.`;
      }
    }
  }
}
