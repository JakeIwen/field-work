import { useState, type FormEvent } from "react";
import type { AppState } from "../../../shared/types";
import { emptyGreenhouseGuidance, type GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";
import { defaultGreenhouseEmploymentScope } from "../../../shared/greenhouse-search";
import { greenhousePolicyProblem, greenhousePullPolicy } from "../../../shared/greenhouse-policy";
import type { Mutate } from "../../workspace/workspace-actions";

export function editableGuidance(settings: AppState["settings"]): GreenhouseGuidanceSave {
  const saved = settings.greenhouseGuidance ?? emptyGreenhouseGuidance;
  return {
    expectedVersion: settings.version ?? 0,
    guidance: { instructions: saved.instructions, searchTerms: saved.searchTerms, employmentScope: saved.employmentScope ?? [...defaultGreenhouseEmploymentScope] },
    excludedCompanies: settings.greenhouseExcludedCompanies ?? [],
    searchTermPool: settings.greenhouseSearchTermPool ?? [],
    policy: greenhousePullPolicy(settings),
  };
}

export function useGuidanceDraft(settings: AppState["settings"], mutate: Mutate, onDirty: (dirty: boolean) => void) {
  const [draft, setDraft] = useState<GreenhouseGuidanceSave | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const value = draft ?? editableGuidance(settings);
  function edit(next: GreenhouseGuidanceSave) {
    setDraft(next); onDirty(true); setMessage(""); setError("");
  }
  function discard() {
    setDraft(null); onDirty(false); setMessage(""); setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    const problem = greenhousePolicyProblem(value.policy);
    if (problem) { setError(problem); return; }
    setSaving(true);
    try {
      await mutate("/api/greenhouse/guidance", value);
      setDraft(null); onDirty(false); setMessage("Saved for new pulls.");
    } catch (cause) { setError(String(cause)); } finally { setSaving(false); }
  }
  return { value, dirty: Boolean(draft), saving, message, error, edit, discard, save };
}
