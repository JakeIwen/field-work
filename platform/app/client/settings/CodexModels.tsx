import "./codex-models.css";
import { useState } from "react";
import { Cpu } from "lucide-react";
import { isModelRequestType, modelRequestGroups, modelRequestTypes, agentProviders, visibleModels, type AgentProvider, type ModelCatalogStatus, type ModelPreferences, type EffortPreferences } from "../../shared/codex-models";
import CodexModelChoiceRow from "./CodexModelChoiceRow";
import SettingsSection from "./SettingsSection";
import type { AppState } from "../../shared/types";
import { useCodexModelCatalog } from "../workspace/CodexModelCatalog";
import { formatDate } from "../ui/dates";
import { type Mutate, type Notify } from "../workspace/workspace-actions";
import InfoTooltip from "../ui/InfoTooltip";
import LetterKey from "../ui/LetterKey";
import { effortLabel, effortLetters, modelLetterChoices } from "../../shared/model-letters";

/** Block explicit choices and effort editing per provider; clearing a preference remains available during outages. */
const unavailableProviders = (catalog: ModelCatalogStatus): ReadonlySet<AgentProvider> => new Set(
  agentProviders.filter(provider => !!catalog.providerErrors?.[provider] || (provider === "codex" && !!catalog.error)),
);

/** Saved choices for request types that no longer exist stay out of the form and of the next save. */
const knownChoices = (saved: ModelPreferences | undefined): ModelPreferences =>
  Object.fromEntries(Object.entries(saved ?? {}).filter(([key]) => isModelRequestType(key)));

function ModelChoices({ state, mutate, notify }: { state: AppState; mutate: Mutate; notify: Notify }) {
  const { catalog, refresh } = useCodexModelCatalog();
  const current = knownChoices(state.settings.codexModels);
  const currentEfforts = knownChoices(state.settings.codexEfforts);
  const [draft, setDraft] = useState<ModelPreferences>(current);
  const [efforts, setEfforts] = useState<EffortPreferences>(currentEfforts);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = modelRequestTypes.some((key) => (draft[key] || "") !== (current[key] || "") || (efforts[key] || "") !== (currentEfforts[key] || ""));
  const models = visibleModels(catalog.models);
  const unavailable = unavailableProviders(catalog);
  const modelKey = modelLetterChoices(models).map(choice => ({ letter: choice.letter, label: choice.short, group: choice.provider }));
  const effortKey = effortLetters(models).map(entry => ({ letter: entry.letter, label: effortLabel(entry.effort) }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await mutate("/api/settings/models", { codexModels: draft, codexEfforts: efforts, expectedVersion: state.settings.version });
      notify("Codex model and effort choices saved");
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="panel-body form-stack">
      <div className="row-wrap">
        <button type="button" className="button secondary" disabled={catalog.refreshing} onClick={() => void refresh().catch((error) => setError(error.message))}>
          {catalog.refreshing ? "Refreshing models…" : "Refresh models"}
        </button>
        <span className="small muted" role="status">{catalog.refreshedAt ? `Updated ${formatDate(catalog.refreshedAt, true)}` : catalog.refreshing ? "Loading models in the background…" : "Model list unavailable"}</span>
      </div>
      {modelKey.length > 0 && <div className="small muted codex-model-key">
        <span>Models</span><LetterKey entries={modelKey} label="Model letters" />
        <span>Effort</span><LetterKey entries={effortKey} label="Effort letters" />
      </div>}
      {catalog.error && <p className="small" role="alert">{catalog.error}</p>}
      {Object.entries(catalog.providerErrors ?? {}).map(([provider, message]) => <p key={provider} className="small muted" role="status">{message}</p>)}
    </div>
    <table className="codex-model-table">
      <colgroup><col /><col className="codex-col-model" /><col className="codex-col-effort" /></colgroup>
      <thead><tr><th scope="col">Request type</th><th scope="col">Model</th><th scope="col">Effort</th></tr></thead>
      {modelRequestGroups.map(group => <tbody key={group.label}>
        <tr className="codex-model-group"><th scope="rowgroup" colSpan={3}>{group.label}</th></tr>
        {group.requests.map(key => <CodexModelChoiceRow key={key} request={key} model={draft[key] || ""} effort={efforts[key] || ""}
          models={models} unavailable={unavailable} saving={saving}
          onModel={value => setDraft(old => ({ ...old, [key]: value }))} onEffort={value => setEfforts(old => ({ ...old, [key]: value }))} />)}
      </tbody>)}
    </table>
    <div className="panel-body form-stack">
      {error && <p className="small" role="alert">{error}</p>}
      <div className="row-wrap">
        <button className="button primary" disabled={saving || !dirty}>{saving ? "Saving…" : "Save model choices"}</button>
        <button type="button" className="button secondary" disabled={saving || ![...Object.values(draft), ...Object.values(efforts)].some(Boolean)} onClick={() => { setDraft({}); setEfforts({}); }}>Use defaults for all</button>
      </div>
    </div>
  </form>;
}

export default function CodexModels(props: { state: AppState; mutate: Mutate; notify: Notify }) {
  const help = "Choose a model and effort for each request type. Changes apply to new requests and follow-up turns; active requests keep their settings. Click a letter to choose, or focus a row and type the letter (arrow keys also move the choice). The dot marks the recommended default while nothing is saved for that request. Unset choices use the Codex recommended default and High effort. Available models refresh in the background at most every 15 minutes. If a chosen model becomes unavailable, the request stops so you can choose another.";
  return <SettingsSection
    id="settings-codex-models"
    title="Models"
    help={<InfoTooltip label="About model choices">{help}</InfoTooltip>}
    icon={<Cpu size={18} aria-hidden="true" />}
  >
    <ModelChoices key={JSON.stringify([props.state.settings.codexModels ?? {}, props.state.settings.codexEfforts ?? {}])} {...props} />
  </SettingsSection>;
}
