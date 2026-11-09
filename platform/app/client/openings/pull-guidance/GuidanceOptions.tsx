import type { GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";
import { greenhouseGuidanceLimits } from "../../../shared/greenhouse-guidance";
import { greenhouseEmploymentScopeOrder, greenhouseEmploymentTypeLabels } from "../../../shared/greenhouse-search";
import InfoTooltip from "../../ui/InfoTooltip";

export function GuidanceOptions({ value, disabled, edit, openCompanies, openTerms }: {
  value: GreenhouseGuidanceSave; disabled: boolean; edit: (next: GreenhouseGuidanceSave) => void;
  openCompanies: (trigger: HTMLButtonElement) => void; openTerms: (trigger: HTMLButtonElement) => void;
}) {
  const types = value.guidance.employmentScope;
  const excluded = value.excludedCompanies ?? [];
  return <div className="pull-guidance-options">
    <div role="group" aria-labelledby="pull-employment-types" className="pull-guidance-option">
      <div className="heading-help"><span id="pull-employment-types">Employment type</span><InfoTooltip label="About employment type searches">Pulls search for and keep only the checked types. Full time applies salary and work-life-balance assessment rules. The other types add engagement and pay-basis checks, plus searches focused on each type while Full time is also checked. Unknown arrangements remain eligible.</InfoTooltip></div>
      {greenhouseEmploymentScopeOrder.map(type => <label className="checkbox-label" key={type}><input type="checkbox" disabled={disabled || (types.length === 1 && types.includes(type))} checked={types.includes(type)} onChange={() => edit({ ...value, guidance: { ...value.guidance, employmentScope: greenhouseEmploymentScopeOrder.filter(candidate => candidate === type ? !types.includes(type) : types.includes(candidate)) } })} />{greenhouseEmploymentTypeLabels[type]}</label>)}
    </div>
    <div className="pull-guidance-option">
      <div className="heading-help"><span>Excluded companies ({excluded.length})</span><InfoTooltip label="About excluded companies">Exclude an exact company name or Greenhouse board token from new and queued search candidates. Existing Openings and running reviews stay unchanged. Move companies between lists by dragging or using the arrow buttons. Include archived counts dismissed, closed and historical Openings too. Apply edits the draft; Save instructions saves it.</InfoTooltip></div>
      <GuidanceChips items={excluded} empty="None excluded" limit={4} />
      <button type="button" className="button secondary" disabled={disabled} onClick={event => openCompanies(event.currentTarget)}>Choose companies</button>
    </div>
    <div className="pull-guidance-option">
      <div className="heading-help"><span>Extra search terms ({value.guidance.searchTerms.length}/{greenhouseGuidanceLimits.searchTerms})</span><InfoTooltip label="About extra search terms">Move terms from the pool into Searching by dragging or using the arrow buttons. These searches alternate with regular software searches; they use the checked employment types. Add custom terms to keep them in the pool. Apply edits the draft; Save instructions saves it.</InfoTooltip></div>
      <GuidanceChips items={value.guidance.searchTerms} empty="Regular searches only" />
      <button type="button" className="button secondary" disabled={disabled} onClick={event => openTerms(event.currentTarget)}>Choose search terms</button>
    </div>
  </div>;
}

function GuidanceChips({ items, empty, limit = items.length }: { items: string[]; empty: string; limit?: number }) {
  return items.length ? <ul className="pull-guidance-chips">{items.slice(0, limit).map(item => <li key={item}>{item}</li>)}{items.length > limit && <li>+{items.length - limit} more</li>}</ul> : <p className="small muted">{empty}</p>;
}
