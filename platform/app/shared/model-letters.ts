import {
  agentProviders,
  modelProvider,
  type AgentProvider,
  type CodexModel,
} from "./codex-models.js";

const effortLabels: Record<string, string> = {
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (effort: string) =>
  effortLabels[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

const capitalized = (word: string) =>
  word.charAt(0).toUpperCase() + word.slice(1);

/** "GPT-6.1-Sol" becomes name "Sol", version "6.1", short "Sol 6.1". */
export function modelShortName(
  model: Pick<CodexModel, "displayName" | "model">,
) {
  const tokens = model.displayName.split(/[\s-]+/).filter(Boolean);
  const kept = tokens.filter((token) => !/^(gpt|claude|codex)$/i.test(token));
  const version = kept.filter((token) => /^[\d.]+$/.test(token)).join(".");
  const named = kept.filter((token) => !/^[\d.]+$/.test(token)).join(" ");
  const name = named ? capitalized(named) : model.model;
  return { name, version, short: `${name} ${version}`.trim() };
}

const usableLetter = /[A-Z0-9]/;
/**
 * Gives each item, in list order, the first character of its label that no earlier item took
 * (a whole-label fallback when all are taken), so letters are stable for a given list.
 */
export function assignLetters<T>(
  items: T[],
  label: (item: T) => string,
): (T & { letter: string })[] {
  const taken = new Set<string>();
  return items.map((item) => {
    const text = label(item).toUpperCase();
    const letter =
      [...text].find((char) => usableLetter.test(char) && !taken.has(char)) ??
      text;
    taken.add(letter);
    return { ...item, letter };
  });
}

export type ModelLetterChoice = {
  model: CodexModel;
  letter: string;
  short: string;
  provider: AgentProvider;
};
/** Visible models by provider, with letters assigned across all providers so no two share one. */
export function modelLetterChoices(models: CodexModel[]): ModelLetterChoice[] {
  const ordered = agentProviders.flatMap((provider) =>
    models
      .filter((model) => !model.hidden && modelProvider(model) === provider)
      .map((model) => ({
        model,
        provider,
        short: modelShortName(model).short,
      })),
  );
  return assignLetters(ordered, (entry) => entry.short);
}

/** One letter per effort offered by any visible model, so a letter means the same effort in every row. */
export function effortLetters(models: CodexModel[]) {
  const efforts = [
    ...new Set(
      models
        .filter((model) => !model.hidden)
        .flatMap((model) =>
          model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
        ),
    ),
  ];
  return assignLetters(
    efforts.map((effort) => ({ effort })),
    (entry) => entry.effort,
  );
}
