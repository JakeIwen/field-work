import { useState } from "react";
import { History } from "lucide-react";
import type { AppState } from "../../../shared/types";
import { greenhouseGuidanceLimits, type GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";
import { defaultGreenhouseEmploymentScope, isDefaultGreenhouseEmploymentScope } from "../../../shared/greenhouse-search";
import type { Mutate } from "../../workspace/workspace-actions";
import InfoTooltip from "../../ui/InfoTooltip";
import { GuidanceHistory } from "./GuidanceHistory";
import { BasePrompt } from "./BasePrompt";
import { GuidanceOptions } from "./GuidanceOptions";
import { CompanyPicker } from "./CompanyPicker";
import { SearchTermPicker } from "./SearchTermPicker";
import { PullConditions } from "./PullConditions";
import { RegularSearchTermPicker } from "./RegularSearchTermPicker";
import { defaultGreenhousePullPolicy, greenhousePullPolicy } from "../../../shared/greenhouse-policy";
import { tunableValue } from "../../../shared/tunables";
import { useGuidanceDraft } from "./useGuidanceDraft";
import "./PullGuidance.css";

type Popup = { kind: "history" | "companies" | "terms" | "regular-terms" | "base-prompt"; value: GreenhouseGuidanceSave };
export function PullGuidance({ state, mutate, onDirty }: {
  state: Pick<AppState, "settings" | "openings" | "personal">; mutate: Mutate; onDirty: (dirty: boolean) => void;
}) {
  const { value, dirty, saving, message, error, edit, discard, save } = useGuidanceDraft(state.settings, mutate, onDirty);
  const [popup, setPopup] = useState<Popup | null>(null);
  const saved = state.settings.greenhouseGuidance;
  const savedPolicy = greenhousePullPolicy(state.settings);
  const policyConfigured = (Object.keys(defaultGreenhousePullPolicy) as (keyof typeof defaultGreenhousePullPolicy)[]).some(key => JSON.stringify(savedPolicy[key]) !== JSON.stringify(defaultGreenhousePullPolicy[key]));
  const configured = Boolean(saved?.instructions || saved?.searchTerms.length || !isDefaultGreenhouseEmploymentScope(saved?.employmentScope) || state.settings.greenhouseExcludedCompanies?.length || state.settings.greenhouseSearchTermPool?.length || policyConfigured);
  const clearable = Boolean(value.guidance.instructions || value.guidance.searchTerms.length || !isDefaultGreenhouseEmploymentScope(value.guidance.employmentScope));
  function open(kind: Popup["kind"], trigger: HTMLButtonElement) { trigger.focus(); setPopup({ kind, value }); }
  function apply(next: GreenhouseGuidanceSave) { edit(next); setPopup(null); }
  const close = () => setPopup(null);
  return <details className="pull-guidance">
    <summary>Pull instructions{dirty ? " · Unsaved changes" : configured ? " · Saved" : ""}</summary>
    <form onSubmit={save} noValidate className="pull-guidance-form">
      <div className="heading-help">
        <label htmlFor="pull-instructions">Instructions for new pulls</label>
        <InfoTooltip label="About pull instructions">Add preferences beyond the employment-type scope and its built-in review rules, such as industries to skip. Saved instructions apply to new pulls until changed or cleared; an existing pull keeps its original instructions when resumed. Greenhouse, remote software eligibility, the chosen conditions and saved technology exclusions still apply. Saving does not start a pull.</InfoTooltip>
        <button type="button" className="icon-button" disabled={saving} aria-label="Pull instruction history" title="Pull instruction history" onClick={event => open("history", event.currentTarget)}><History size={17} aria-hidden="true" /></button>
      </div>
      <textarea id="pull-instructions" rows={4} maxLength={greenhouseGuidanceLimits.instructions} value={value.guidance.instructions} disabled={saving} placeholder="Skip gambling and defense-industry roles." onChange={event => edit({ ...value, guidance: { ...value.guidance, instructions: event.target.value } })} />
      <GuidanceOptions value={value} disabled={saving} edit={edit} openCompanies={trigger => open("companies", trigger)} openTerms={trigger => open("terms", trigger)} />
      <PullConditions policy={value.policy ?? savedPolicy} cardDateMarginDays={tunableValue(state.settings, "greenhouse.cardDateMarginDays")} disabled={saving} edit={policy => edit({ ...value, policy })} openTerms={trigger => open("regular-terms", trigger)} />
      {dirty && <p className="small" role="status">Save or discard your changes before starting a new pull.</p>}
      <div className="actions">
        <button className="button secondary" disabled={!dirty || saving}>{saving ? "Saving…" : "Save instructions"}</button>
        <button type="button" className="button secondary" disabled={saving} onClick={event => open("base-prompt", event.currentTarget)}>Base prompt</button>
        {dirty && <button type="button" className="text-button" disabled={saving} onClick={discard}>Discard changes</button>}
        {clearable && <button type="button" className="text-button" disabled={saving} onClick={() => edit({ ...value, guidance: { instructions: "", searchTerms: [], employmentScope: [...defaultGreenhouseEmploymentScope] } })}>Clear instructions</button>}
      </div>
      {message && <p className="small" role="status">{message}</p>}
      {error && <p className="intake-error" role="alert">{error}</p>}
    </form>
    {popup?.kind === "base-prompt" && <BasePrompt onClose={close} />}
    {popup?.kind === "history" && <GuidanceHistory mutate={mutate} onClose={close} onUse={instructions => apply({ ...popup.value, guidance: { ...popup.value.guidance, instructions } })} />}
    {popup?.kind === "companies" && <CompanyPicker state={state} initial={popup.value.excludedCompanies ?? []} onClose={close} onApply={excludedCompanies => apply({ ...popup.value, excludedCompanies })} />}
    {popup?.kind === "regular-terms" && <RegularSearchTermPicker initialTerms={popup.value.policy?.regularSearchTerms ?? savedPolicy.regularSearchTerms} onClose={close} onApply={regularSearchTerms => apply({ ...popup.value, policy: { ...(popup.value.policy ?? savedPolicy), regularSearchTerms } })} />}
    {popup?.kind === "terms" && <SearchTermPicker initialTerms={popup.value.guidance.searchTerms} initialPool={popup.value.searchTermPool ?? []} onClose={close} onApply={(searchTerms, searchTermPool) => apply({ ...popup.value, guidance: { ...popup.value.guidance, searchTerms }, searchTermPool })} />}
  </details>;
}
