import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../shared/types";
import {
  tunableGroups, tunableLabel, tunables, tunableValue, tunableProblem, tunablesConflict, tunablesPath, tunablesProblem,
  tunablesRevision, unitSuffix, type TunableDefinition, type TunableKey, type TunableSettings, type TunablesSave,
} from "../../shared/tunables";
import type { Mutate, Notify } from "../workspace/workspace-actions";
import { SearchBox } from "../ui/SearchBox";
import InfoTooltip from "../ui/InfoTooltip";
import SettingsSection from "./SettingsSection";
import "./tunables.css";

const keys = Object.keys(tunables) as TunableKey[];
// `settings` and `revision` are the saved state the draft was started from; a save
// is checked against that revision so another writer's change is never overwritten.
type Edit = { settings: TunableSettings; revision: number; values: Partial<Record<TunableKey, string | null>>; stale?: boolean };
const conflictNotice = "Settings changed elsewhere; your edits are kept, save again.";

export default function Tunables({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  return <SettingsSection id="settings-tunables" title="Timing & limits" collapsible
    help={<InfoTooltip label="About timing and limits">Operational waits, retries and limits. Defaults are the app's built-in values. Changes take effect at the next use; work already waiting keeps the value it read. Resetting a row with Default returns it to its built-in value when you save.</InfoTooltip>}>
    <TunablesForm state={state} mutate={mutate} notify={notify} />
  </SettingsSection>;
}

function TunablesForm({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(state.settings);
  latest.current = state.settings;
  const saved = edit?.settings ?? state.settings;
  const value = (key: TunableKey) => edit?.values[key] === null ? String(tunables[key].default) : edit?.values[key] ?? String(tunableValue(saved, key));
  const rowProblem = (key: TunableKey) => value(key).trim() === ""
    ? `"${tunableLabel(key)}" requires a number from ${tunables[key].min} to ${tunables[key].max}${unitSuffix(tunables[key])}.`
    : tunableProblem(key, Number(value(key)));
  const proposed = { ...saved.tunables };
  for (const key of keys) {
    if (edit?.values[key] === null) delete proposed[key];
    else if (edit?.values[key] !== undefined) proposed[key] = Number(value(key));
  }
  const crossProblem = tunablesProblem(proposed);
  const invalidKeys = keys.filter(key => rowProblem(key) !== null);
  const invalid = invalidKeys.length > 0 || Boolean(crossProblem);
  const changedKeys = keys.filter(key => edit?.values[key] !== undefined && (edit.values[key] === null ? saved.tunables?.[key] !== undefined : Number(value(key)) !== tunableValue(saved, key)));
  const search = query.trim().toLocaleLowerCase();
  const visible = keys.filter(key => `${key} ${tunables[key].label} ${tunables[key].help}`.toLocaleLowerCase().includes(search));
  const hiddenInvalid = invalidKeys.filter(key => !visible.includes(key));
  // After a conflict, move the draft onto the refreshed saved values once they arrive.
  const revision = tunablesRevision(state.settings);
  useEffect(() => {
    if (edit?.stale && edit.revision !== revision) setEdit({ ...edit, settings: latest.current, revision, stale: false });
  }, [edit, revision]);
  function change(key: TunableKey, next: string | null) {
    setEdit(previous => ({ settings: previous?.settings ?? state.settings, revision: previous?.revision ?? revision, values: { ...previous?.values, [key]: next }, stale: previous?.stale }));
    setError("");
  }
  async function save() {
    if (!edit || invalid || !changedKeys.length || saving) return;
    setSaving(true); setError("");
    try {
      const values: TunablesSave["values"] = {};
      for (const key of changedKeys) values[key] = edit.values[key] === null ? null : Number(value(key));
      await mutate(tunablesPath, { expectedRevision: edit.revision, values } satisfies TunablesSave);
      setEdit(null);
      notify("Timing and limits saved");
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (message.includes(tunablesConflict)) {
        setEdit(previous => previous && { ...previous, stale: true });
        setError(conflictNotice);
      } else setError(message);
    } finally { setSaving(false); }
  }
  return <div className="panel-body tunables-panel">
    <SearchBox value={query} onChange={setQuery} placeholder="Search timing and limits" />
    <form className="form-stack" aria-label="Timing and limits" onSubmit={event => { event.preventDefault(); void save(); }}>
      {tunableGroups.map(group => {
        const rows = visible.filter(key => tunables[key].group === group.id);
        if (!rows.length) return null;
        return <section className="tunable-group" key={group.id} aria-labelledby={`tunables-${group.id}`}>
          <div className="heading-help"><h3 id={`tunables-${group.id}`}>{group.label}</h3><InfoTooltip label={`About ${group.label}`}>{group.description}</InfoTooltip></div>
          {rows.map(key => <TunableRow key={key} entry={tunables[key]} value={value(key)} problem={rowProblem(key)}
            overridden={proposed[key] !== undefined && proposed[key] !== tunables[key].default} saving={saving} change={next => change(key, next)} />)}
        </section>;
      })}
      {!visible.length && <p role="status">No matching timing or limit settings.</p>}
      {crossProblem && <p role="alert">{crossProblem}</p>}
      {hiddenInvalid.length > 0 && <p role="alert">{hiddenInvalid.length} {hiddenInvalid.length === 1 ? "row" : "rows"} hidden by the search {hiddenInvalid.length === 1 ? "has an invalid value" : "have invalid values"}: {hiddenInvalid.map(tunableLabel).join(", ")}.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="row-wrap">
        <button className="button primary" disabled={saving || invalid || !changedKeys.length}>{saving ? "Saving…" : "Save"}</button>
        {edit && <button type="button" className="button secondary" disabled={saving} onClick={() => { setEdit(null); setError(""); }}>Use current values</button>}
      </div>
    </form>
  </div>;
}

function TunableRow({ entry, value, problem, overridden, saving, change }: {
  entry: TunableDefinition; value: string; problem: string | null; overridden: boolean; saving: boolean; change: (value: string | null) => void;
}) {
  const id = `tunable-${entry.key}`;
  const unit = unitSuffix(entry).trim();
  return <div className="tunable-row">
    <div className="heading-help"><label htmlFor={id}>{entry.label}</label>
      <InfoTooltip label={`About ${entry.label}`}>{entry.help} Default {entry.default}{unit && ` ${unit}`} · allowed {entry.min}–{entry.max}{unit && ` ${unit}`}.</InfoTooltip>
      {overridden && <span className="small muted">changed</span>}
    </div>
    <div className="tunable-controls">
      <input id={id} type="number" required min={entry.min} max={entry.max} step={entry.step ?? 1} value={value} disabled={saving}
        aria-invalid={Boolean(problem)} aria-describedby={problem ? `${id}-error` : undefined} onChange={event => change(event.target.value)} />
      {unit && <span>{unit}</span>}
      {(value.trim() === "" || Number(value) !== entry.default) && <button type="button" className="text-button" disabled={saving} onClick={() => change(null)}>Default</button>}
    </div>
    {problem && <p className="tunable-error" id={`${id}-error`} role="alert">{problem}</p>}
  </div>;
}
