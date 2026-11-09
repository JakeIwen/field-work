import { DEFAULT_EFFORT, agentProviderLabels, modelProvider, modelRequestLabels, supportsReasoningEffort, type AgentProvider, type CodexModel, type ModelRequestType } from "../../shared/codex-models";
import { effortLabel, effortLetters, modelLetterChoices, modelShortName } from "../../shared/model-letters";
import LetterPicker, { type LetterOption } from "../ui/LetterPicker";

const RECOMMENDED = " (recommended default)";

/** One request type's row in the Codex models table: the model choice and the efforts that model advertises. */
export default function CodexModelChoiceRow({ request, model, effort, models, unavailable, saving, onModel, onEffort }: {
  request: ModelRequestType; model: string; effort: string; models: CodexModel[];
  /** Providers whose catalog reported an error; their models cannot be chosen. */
  unavailable: ReadonlySet<AgentProvider>; saving: boolean; onModel: (value: string) => void; onEffort: (value: string) => void;
}) {
  const label = modelRequestLabels[request];
  const defaults = models.filter(entry => entry.isDefault);
  const selected = model ? models.find(entry => entry.model === model) : defaults.length === 1 ? defaults[0] : undefined;
  const implicit = !model ? selected : undefined;
  const effectiveEffort = effort || DEFAULT_EFFORT;
  const supported = selected && supportsReasoningEffort(selected, effectiveEffort);
  const blocked = (entry: CodexModel) => unavailable.has(modelProvider(entry));
  const modelOptions: LetterOption[] = modelLetterChoices(models).map(choice => ({
    id: choice.model.model, letter: choice.letter, group: choice.provider,
    label: `${choice.short} · ${agentProviderLabels[choice.provider]}${choice.model === implicit ? RECOMMENDED : ""}`,
    disabled: blocked(choice.model) || !choice.model.supportedReasoningEfforts.length,
    marker: choice.model === implicit ? "default" : undefined,
  }));
  // A saved model the catalog no longer offers (withdrawn, or hidden as superseded) stays visible until another is chosen.
  if (model && !selected) modelOptions.push({
    id: model, letter: modelShortName({ displayName: model, model }).short, label: `${model} (unavailable)`, group: "unavailable", unavailable: true,
  });
  const letters = effortLetters(models);
  const letterFor = (value: string) => letters.find(entry => entry.effort === value)?.letter;
  const effortOptions: LetterOption[] = (selected?.supportedReasoningEfforts ?? []).map(entry => ({
    id: entry.reasoningEffort, letter: letterFor(entry.reasoningEffort) ?? effortLabel(entry.reasoningEffort), label: effortLabel(entry.reasoningEffort),
  }));
  if (!supported) effortOptions.push({
    id: effectiveEffort, letter: letterFor(effectiveEffort) ?? effortLabel(effectiveEffort), label: `${effortLabel(effectiveEffort)} (unavailable)`, unavailable: true,
  });
  return <tr className="codex-model-choice">
    <th scope="row">{label}</th>
    <td>
      <LetterPicker label={label} value={model || selected?.model || ""} options={modelOptions} disabled={saving} onChange={onModel} />
    </td>
    <td>
      <LetterPicker label={`${label} effort`} value={effectiveEffort} options={effortOptions} disabled={saving || !selected || blocked(selected)} onChange={onEffort} />
      {selected && !supported && <p className="small" role="alert">This model does not support {effectiveEffort} effort. Choose an available effort before saving.</p>}
    </td>
  </tr>;
}
