import { tunableValue } from "../../shared/tunables";
import { useState } from "react";
import type { AppState } from "../../shared/types";
import { greenhouseDefaultPacingMs, greenhouseDefaultPacingPenaltyMs, greenhouseDriverIntervalBounds } from "../../shared/greenhouse-search";
import { greenhouseDefaultParallelReviews, greenhouseParallelReviewBounds, greenhouseSearchLookaheadBounds, greenhouseFormulaSearchLookahead } from "../../shared/greenhouse-pull";
import type { Mutate, Notify } from "../workspace/workspace-actions";
import InfoTooltip from "../ui/InfoTooltip";
import SettingsSection from "./SettingsSection";

type PullValues = { pacingRate: string; parallelReviews: string; searchLookahead: string };
const formCheckHelp = "New openings a pull publishes get a model-free read of their application form, so the Openings list shows how many questions need your own answer. The pass reads the form only; it never drafts answers or submits. The manual form question check still checks every opening.";
const fields = {
  pacingRate: {
    label: "Page interval (ms)", id: "greenhouse-page-interval", bounds: greenhouseDriverIntervalBounds,
    helpLabel: "About Greenhouse page interval",
    help: (recoveryPages: number, pacingStepSeconds: number) => `Minimum time between MyGreenhouse search page requests. The page interval is the manual floor (default 2 s). Search errors add ${pacingStepSeconds} s of adaptive delay, but browser bridge failures do not; every ${recoveryPages} clean pages removes ${pacingStepSeconds} s, never below the floor. The delay carries into later pulls. Manual changes apply to the next pull; the current pull keeps its captured floor. Clear adaptive delay saves the form with no adaptive delay for the next pull.`,
    error: "Enter whole milliseconds from 1000 to 60000.",
  },
  parallelReviews: {
    label: "Parallel reviews", id: "greenhouse-parallel-reviews", bounds: greenhouseParallelReviewBounds,
    helpLabel: "About parallel reviews", help: "How many reviews a pull runs at once. Changes apply to active pulls without interrupting running reviews.",
    error: "Enter a whole number from 1 to 10.",
  },
  searchLookahead: {
    label: "Search lookahead", id: "greenhouse-search-lookahead", bounds: greenhouseSearchLookaheadBounds,
    helpLabel: "About search lookahead", help: "Search requests the next page when fewer than this many found, not-yet-reviewed results are queued. Changing Parallel reviews resets this to the same number; edit it afterwards to override. Changes apply to active pulls.",
    error: "Enter a whole number from 1 to 40.",
  },
} satisfies Record<keyof PullValues, { label: string; id: string; bounds: { min: number; max: number }; helpLabel: string; help: string | ((recoveryPages: number, pacingStepSeconds: number) => string); error: string }>;
const fieldKeys = Object.keys(fields) as (keyof PullValues)[];

export default function GreenhousePacing({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  const parallelReviews = state.settings.parallelReviews ?? greenhouseDefaultParallelReviews;
  const penalty = state.settings.greenhousePacingPenaltyMs ?? greenhouseDefaultPacingPenaltyMs;
  const floor = state.settings.greenhousePacingRate ?? greenhouseDefaultPacingMs;
  const saved: PullValues = {
    pacingRate: String(state.settings.greenhousePacingRate ?? greenhouseDefaultPacingMs),
    parallelReviews: String(parallelReviews),
    searchLookahead: String(state.settings.greenhouseSearchLookahead ?? greenhouseFormulaSearchLookahead(parallelReviews)),
  };
  const [edit, setEdit] = useState<{ values: PullValues; formCheck: boolean; version: number } | null>(null);
  const savedCheck = state.settings.greenhouseFormCheckNewOpenings !== false;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const values = edit?.values ?? saved;
  const formCheck = edit?.formCheck ?? savedCheck;
  const invalid = (key: keyof PullValues) => {
    const value = Number(values[key]);
    const { min, max } = fields[key].bounds;
    return !Number.isInteger(value) || value < min || value > max;
  };
  const unchanged = formCheck === savedCheck && fieldKeys.every(key => Number(values[key]) === Number(saved[key]));
  function change(key: keyof PullValues, value: string) {
    setEdit(previous => ({
      version: previous?.version ?? state.settings.version ?? 0,
      formCheck: previous?.formCheck ?? savedCheck,
      values: { ...(previous?.values ?? saved), [key]: value,
        ...(key === "parallelReviews" ? { searchLookahead: String(greenhouseFormulaSearchLookahead(Number(value))) } : {}),
      },
    }));
  }
  function changeFormCheck(checked: boolean) {
    setEdit(previous => ({ version: previous?.version ?? state.settings.version ?? 0, values: previous?.values ?? saved, formCheck: checked }));
  }
  async function save(clearPenalty = false) {
    if ((!edit && !clearPenalty) || fieldKeys.some(invalid) || saving) return;
    setSaving(true); setError("");
    try {
      await mutate("/api/greenhouse/pull-settings", { expectedVersion: edit?.version ?? state.settings.version ?? 0, pacingRate: Number(values.pacingRate), parallelReviews: Number(values.parallelReviews), searchLookahead: Number(values.searchLookahead), formCheckNewOpenings: formCheck, ...(clearPenalty ? { pacingPenaltyMs: 0 } : {}) });
      setEdit(null);
      notify(clearPenalty ? "Adaptive delay cleared for the next pull" : "Greenhouse pull settings saved; page interval applies to the next pull");
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  }
  return <SettingsSection id="settings-greenhouse-pulls" title="Greenhouse pulls">
    <form className="panel-body form-stack" aria-label="Greenhouse pull settings" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="greenhouse-pull-fields">
        {fieldKeys.map(key => <div className="greenhouse-pull-field" key={key}>
          <div className="heading-help">
            <label htmlFor={fields[key].id}>{fields[key].label}</label>
            <InfoTooltip label={fields[key].helpLabel}>{typeof fields[key].help === "function" ? fields[key].help(tunableValue(state.settings, "greenhouse.pacingRecoveryPages"), tunableValue(state.settings, "greenhouse.pacingStepMs") / 1000) : fields[key].help}</InfoTooltip>
          </div>
          <input id={fields[key].id} type="number" min={fields[key].bounds.min} max={fields[key].bounds.max} step={1} required value={values[key]} disabled={saving}
            aria-invalid={Boolean(edit && invalid(key))} aria-describedby={edit && invalid(key) ? `${fields[key].id}-error` : undefined}
            onChange={event => change(key, event.target.value)} />
          <div>{edit && invalid(key) && <p id={`${fields[key].id}-error`} role="alert">{fields[key].error}</p>}</div>
          {key === "pacingRate" && <div className="row-wrap">
            <span role="status">now {floor / 1000} s + {penalty / 1000} s adaptive = {(floor + penalty) / 1000} s</span>
            <button type="button" className="text-button" disabled={saving || penalty === 0 || fieldKeys.some(invalid)} onClick={() => void save(true)}>Clear adaptive delay</button>
          </div>}
        </div>)}
      </div>
      <div className="heading-help">
        <label htmlFor="greenhouse-form-check-new"><input id="greenhouse-form-check-new" type="checkbox" checked={formCheck} disabled={saving} onChange={event => changeFormCheck(event.target.checked)} /> Check form questions for new openings</label>
        <InfoTooltip label="About checking form questions for new openings">{formCheckHelp}</InfoTooltip>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="row-wrap">
        <button className="button primary" disabled={saving || fieldKeys.some(invalid) || !edit || unchanged}>{saving ? "Saving…" : "Save"}</button>
        {edit && <button type="button" className="button secondary" disabled={saving} onClick={() => { setEdit(null); setError(""); }}>Use current values</button>}
      </div>
    </form>
  </SettingsSection>;
}
