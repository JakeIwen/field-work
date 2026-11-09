import { useState } from "react";
import type { AppState } from "../../shared/types";
import { preparationDefaultParallelRuns, preparationParallelRunBounds, preparationSettingsPath, type PreparationSettingsSave } from "../../shared/preparation-settings";
import type { Mutate, Notify } from "../workspace/workspace-actions";
import InfoTooltip from "../ui/InfoTooltip";
import SettingsSection from "./SettingsSection";

export default function PreparationSettings({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  const saved = state.settings.parallelPreparations ?? preparationDefaultParallelRuns;
  const [edit, setEdit] = useState<{ value: string; version: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const value = edit?.value ?? String(saved);
  const number = Number(value);
  const { min, max } = preparationParallelRunBounds;
  const invalid = !Number.isInteger(number) || number < min || number > max;
  async function save() {
    if (!edit || invalid || saving) return;
    setSaving(true); setError("");
    try {
      const body: PreparationSettingsSave = { expectedVersion: edit.version, parallelPreparations: number };
      await mutate(preparationSettingsPath, body);
      setEdit(null);
      notify("Generate Docs settings saved");
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  }
  return <SettingsSection id="settings-generate-docs" title="Generate Docs"
    help={<InfoTooltip label="About parallel preparations">How many Openings Generate Docs prepares at once, including PDFs, answers and the autofill script. Default: {preparationDefaultParallelRuns}. Changes apply immediately: raising the limit lets queued preparations start; lowering it never interrupts running preparations. Preparations waiting for your input leave room for queued work.</InfoTooltip>}>
    <form className="panel-body form-stack" aria-label="Generate Docs settings" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor="preparation-parallel-runs">Parallel preparations</label>
      <input id="preparation-parallel-runs" type="number" min={min} max={max} step={1} required value={value} disabled={saving}
        aria-invalid={Boolean(edit && invalid)} aria-describedby={edit && invalid ? "preparation-parallel-runs-error" : undefined}
        onChange={event => setEdit(previous => ({ value: event.target.value, version: previous?.version ?? state.settings.version ?? 0 }))} />
      {edit && invalid && <p id="preparation-parallel-runs-error" role="alert">Enter a whole number from {min} to {max}.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="row-wrap">
        <button className="button primary" disabled={saving || invalid || !edit || number === saved}>{saving ? "Saving…" : "Save"}</button>
        {edit && <button type="button" className="button secondary" disabled={saving} onClick={() => { setEdit(null); setError(""); }}>Use current value</button>}
      </div>
    </form>
  </SettingsSection>;
}
