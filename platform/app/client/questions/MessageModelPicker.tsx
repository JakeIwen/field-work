import "./message-model-picker.css";
import {
  agentProviderLabels,
  modelProvider,
  visibleModels,
  type AgentProvider,
  type CodexModel,
  type EffortPreferences,
  type ModelPreferences,
  type ModelRequestType,
} from "../../shared/codex-models";
import {
  configuredSelection,
  type ModelSelection,
} from "../../shared/model-selection";
import { useCodexModelCatalog } from "../workspace/CodexModelCatalog";
import InfoTooltip from "../ui/InfoTooltip";
import LetterKey from "../ui/LetterKey";
import LetterPicker, { type LetterOption } from "../ui/LetterPicker";
import { modelLetterChoices, modelShortName } from "../../shared/model-letters";
import {
  nextTurnSelection,
  type NextTurnModelTask,
} from "./ModelSelection";

type Props = {
  request: ModelRequestType | readonly ModelRequestType[];
  preferences?: ModelPreferences;
  efforts?: EffortPreferences;
  fallback?: ModelSelection | null;
  task?: NextTurnModelTask;
  value?: string;
  onChange: (model: string | undefined) => void;
  disabled?: boolean;
  active?: boolean;
};

const unavailableProvider = (
  provider: AgentProvider,
  error: string | null,
  providerErrors: Partial<Record<AgentProvider, string>> | undefined,
) => Boolean(providerErrors?.[provider] || (provider === "codex" && error));

const MIXED = Symbol("mixed saved defaults");

/** The model Automatic resolves to, or MIXED when the request types disagree. */
function automaticModel(
  models: CodexModel[],
  request: Props["request"],
  preferences: ModelPreferences | undefined,
  efforts: EffortPreferences | undefined,
  fallback: ModelSelection | null | undefined,
  task: NextTurnModelTask | undefined,
) {
  const requestTypes = Array.isArray(request) ? request : [request];
  const configured = requestTypes.map((type) =>
    configuredSelection(preferences, type, fallback, efforts),
  );
  const mixedDefaults =
    !task &&
    new Set(configured.map((selection) => selection?.model || "")).size > 1;
  if (mixedDefaults) return MIXED;
  const automatic = task
    ? nextTurnSelection(preferences, efforts, task, fallback)
    : configured[0];
  return automatic?.model || models.find((entry) => entry.isDefault)?.model;
}

const automaticLabelFor = (models: CodexModel[], automatic: string | typeof MIXED | undefined) =>
  automatic === MIXED
    ? "saved defaults"
    : automatic
      ? models.find((entry) => entry.model === automatic)?.displayName ||
        automatic
      : "default";

/** A one-message override. Leaving Automatic selected deliberately omits `model` from the request. */
export default function MessageModelPicker({
  request,
  preferences,
  efforts,
  fallback,
  task,
  value,
  onChange,
  disabled = false,
  active = false,
}: Props) {
  const id = task ? "qa-followup-model" : "qa-new-model";
  const { catalog } = useCodexModelCatalog();
  const models = visibleModels(catalog.models);
  const automatic = automaticModel(models, request, preferences, efforts, fallback, task);
  const automaticLabel = automaticLabelFor(models, automatic);
  const choices = modelLetterChoices(models);
  const options: LetterOption[] = [
    { id: "", letter: "Auto", label: `Automatic · ${automaticLabel}`, group: "automatic" },
    ...choices.map((choice) => ({
      id: choice.model.model,
      letter: choice.letter,
      group: choice.provider,
      label: `${choice.short} · ${agentProviderLabels[choice.provider]}${!value && choice.model.model === automatic ? " (automatic)" : ""}`,
      disabled:
        unavailableProvider(modelProvider(choice.model), catalog.error, catalog.providerErrors) ||
        !choice.model.supportedReasoningEfforts.length,
      marker: !value && choice.model.model === automatic ? ("default" as const) : undefined,
    })),
  ];
  if (value && !models.some((entry) => entry.model === value))
    options.push({
      id: value,
      letter: modelShortName({ displayName: value, model: value }).short,
      label: `${value} (unavailable)`,
      group: "unavailable",
      unavailable: true,
    });
  const help = active
    ? "The current active turn keeps the model it started with. Wait for it to finish or stop it before choosing a model for the next message."
    : "Automatic keeps the saved model setting and normal thread routing. A same-provider choice continues the existing thread. A choice from another provider starts a new thread with the same captured sources and visible user and assistant messages; tool history is not copied. The saved effort is used when supported, otherwise High.";

  return (
    <div className="message-model-picker">
      <span className="heading-help message-model-picker-label">
        <span>Model</span>
        <InfoTooltip label="About message model choice">
          <p>{help}</p>
          <LetterKey
            label="Model letters"
            entries={choices.map((choice) => ({ letter: choice.letter, label: choice.short, group: choice.provider }))}
          />
        </InfoTooltip>
      </span>
      <LetterPicker
        id={id}
        size="compact"
        label="Model for this message"
        value={value || ""}
        options={options}
        disabled={disabled}
        onChange={(next) => onChange(next || undefined)}
      />
    </div>
  );
}
