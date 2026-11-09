import { cardDateMarginText, greenhouseCardDateMarginDays, type CapturedGreenhousePolicy, type GreenhousePullPolicy } from "../../../shared/greenhouse-policy";
import InfoTooltip from "../../ui/InfoTooltip";

function pullConditionsText(policy: GreenhousePullPolicy): string {
  return `${policy.freshnessDays} day${policy.freshnessDays === 1 ? "" : "s"} · ${policy.travelCapPercent === null ? "travel uncapped" : `travel ≤ ${policy.travelCapPercent}%`} · language rule ${policy.excludeMissingLanguage ? "on" : "off"} · reuse reviews ${policy.reuseReviews ? `on (deferrals ${policy.deferralReuseHours} h)` : "off"} · title skip ${policy.titleTriage ? "on" : "off"} · ${policy.regularSearchTerms.length} search term${policy.regularSearchTerms.length === 1 ? "" : "s"}`;
}

/** `cardDateMarginDays` is the saved setting for a new pull; a run shows the margin it captured. */
export function PullConditionsSummary({ policy, captured = false, legacy = false, cardDateMarginDays = greenhouseCardDateMarginDays }: {
  policy?: GreenhousePullPolicy & Partial<CapturedGreenhousePolicy>; captured?: boolean; legacy?: boolean; cardDateMarginDays?: number;
}) {
  const isLegacy = captured && (!policy || legacy || ("legacy" in policy && policy.legacy === true));
  const label = isLegacy ? "Legacy conditions" : captured ? "Conditions" : "New pull conditions";
  return <p className="small pull-conditions-summary">
    <span>{label}: {policy ? pullConditionsText(policy) : "No captured policy"}</span>{" "}
    <InfoTooltip label={`About ${label.toLowerCase()}`}>
      <p>{captured ? isLegacy ? "This is a legacy pull. Only conditions recorded with the pull are shown; missing conditions are not inferred from today's settings." : "These conditions were captured when this pull started. Later saved changes apply only to new pulls." : "A new pull captures these saved conditions. Unsaved edits do not change this summary, and existing pulls keep their captured conditions."}</p>
      {policy && <>
        <p>Age uses original publication, not update dates; search cards allow {cardDateMarginText(captured ? policy?.cardDateMarginDays ?? greenhouseCardDateMarginDays : cardDateMarginDays)} more. Required-travel ranges use their upper bound, and the review also judges travel described in words. The language rule concerns a role's defining language, not incidental mentions. Review reuse requires matching inputs; the deferral age does not expire exclusions. Saved Role keywords to exclude still apply when title skipping is off.</p>
        <p>Regular search terms: {policy.regularSearchTerms.join(", ")}</p>
        {policy.titleExcludeTerms && <p>Role keywords to exclude: {policy.titleExcludeTerms.join(", ") || "None"}</p>}
        {policy.technologyExcludeTerms && <p>Technology exclusions: {policy.technologyExcludeTerms.join(", ") || "None"}</p>}
        {policy.excludedCompanies && <p>Excluded companies: {policy.excludedCompanies.join(", ") || "None"}</p>}
      </>}
    </InfoTooltip>
  </p>;
}
