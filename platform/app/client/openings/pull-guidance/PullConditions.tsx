import { cardDateMarginText, greenhousePolicyBounds, defaultGreenhousePullPolicy, greenhouseDefaultRegularSearchTerms, type GreenhousePullPolicy } from "../../../shared/greenhouse-policy";
import InfoTooltip from "../../ui/InfoTooltip";
import "./PullConditions.css";

export function PullConditions({ policy, cardDateMarginDays, disabled, edit, openTerms }: {
  policy: GreenhousePullPolicy; cardDateMarginDays: number; disabled: boolean; edit: (policy: GreenhousePullPolicy) => void;
  openTerms: (trigger: HTMLButtonElement) => void;
}) {
  const bounds = greenhousePolicyBounds;
  return <fieldset className="pull-conditions" disabled={disabled}>
    <legend>Conditions</legend>
    <div className="pull-conditions-grid">
      <div>
        <div className="heading-help"><label htmlFor="pull-freshness">Maximum age since original publication (days)</label><InfoTooltip label="About maximum publication age">Uses the posting API's original publication date, not its update date. The search itself covers the past ten days; search cards older than this limit plus {cardDateMarginText(cardDateMarginDays)} are skipped before retrieval. An unknown original-publication date stays unknown.</InfoTooltip></div>
        <input id="pull-freshness" type="number" min={bounds.freshnessDays.min} max={bounds.freshnessDays.max} step="1" value={Number.isFinite(policy.freshnessDays) ? policy.freshnessDays : ""} onChange={event => edit({ ...policy, freshnessDays: event.target.valueAsNumber })} />
      </div>
      <div>
        <div className="heading-help"><label htmlFor="pull-travel">Maximum required travel (%)</label><InfoTooltip label="About maximum required travel">Explicit required-travel percentages are checked in code; a range uses its upper bound. The review also judges travel described in words against the same cap. No cap disables both travel limits, not the other conditions.</InfoTooltip></div>
        <div className="pull-conditions-input-row">
          <input id="pull-travel" type="number" min={bounds.travelCapPercent.min} max={bounds.travelCapPercent.max} step="1" disabled={policy.travelCapPercent === null} value={policy.travelCapPercent !== null && Number.isFinite(policy.travelCapPercent) ? policy.travelCapPercent : ""} onChange={event => edit({ ...policy, travelCapPercent: event.target.valueAsNumber })} />
          <label className="checkbox-label"><input type="checkbox" checked={policy.travelCapPercent === null} onChange={event => edit({ ...policy, travelCapPercent: event.target.checked ? null : defaultGreenhousePullPolicy.travelCapPercent })} />No cap</label>
        </div>
      </div>
      <div className="heading-help">
        <label className="checkbox-label"><input type="checkbox" checked={policy.excludeMissingLanguage} onChange={event => edit({ ...policy, excludeMissingLanguage: event.target.checked })} />Exclude roles defined by a language not on the resume</label>
        <InfoTooltip label="About missing-language exclusion">The review excludes roles whose central work is defined by a programming language absent from the current resume. Mixed-language, preferred and incidental language mentions remain eligible; this is not a keyword-only screen.</InfoTooltip>
      </div>
      <div>
        <div className="heading-help">
          <label className="checkbox-label"><input type="checkbox" checked={policy.reuseReviews} onChange={event => edit({ ...policy, reuseReviews: event.target.checked })} />Reuse earlier review decisions</label>
          <InfoTooltip label="About reusing review decisions">Reuses earlier source-backed exclusions and unexpired deferrals only when their decision inputs still match. Turning this off requests a fresh review after the other screens; it does not erase earlier evidence or change saved Openings.</InfoTooltip>
        </div>
        {policy.reuseReviews && <div>
          <div className="heading-help"><label htmlFor="pull-deferral-hours">Deferrals count for (hours)</label><InfoTooltip label="About deferral reuse hours">An earlier deferral can be reused for this many hours after its decision, provided the inputs still match. Exclusions do not use this expiry; expired deferrals receive a fresh review.</InfoTooltip></div>
          <input id="pull-deferral-hours" type="number" min={bounds.deferralReuseHours.min} max={bounds.deferralReuseHours.max} step="1" value={Number.isFinite(policy.deferralReuseHours) ? policy.deferralReuseHours : ""} onChange={event => edit({ ...policy, deferralReuseHours: event.target.valueAsNumber })} />
        </div>}
      </div>
      <div className="heading-help">
        <label className="checkbox-label"><input type="checkbox" checked={policy.titleTriage} onChange={event => edit({ ...policy, titleTriage: event.target.checked })} />Skip clearly non-software titles before retrieval</label>
        <InfoTooltip label="About non-software title skipping">Skips plainly non-software search-card titles before fetching the posting or starting review. Saved Role keywords to exclude still apply when this is off; ambiguous software titles continue to posting review.</InfoTooltip>
      </div>
      <div>
        <div className="heading-help"><span>Regular search terms ({policy.regularSearchTerms.length}/{bounds.regularSearchTerms.max})</span><button type="button" className="text-button" aria-label="Choose regular search terms" title="Choose regular search terms" onClick={event => openTerms(event.currentTarget)}>Choose</button><InfoTooltip label="About regular search terms">These terms are the regular searches a new pull rotates through, using the checked employment types. Choose 1–16 distinct terms of up to 100 characters. Extra search terms remain separate and alternate with these searches. Apply edits the draft; Save instructions saves it.</InfoTooltip></div>
        <ul className="pull-guidance-chips">{policy.regularSearchTerms.map(term => <li key={term}>{term}</li>)}</ul>
        <div className="actions">
          <button type="button" className="text-button" onClick={() => edit({ ...policy, regularSearchTerms: [...greenhouseDefaultRegularSearchTerms] })}>Reset to defaults</button>
        </div>
      </div>
    </div>
  </fieldset>;
}
