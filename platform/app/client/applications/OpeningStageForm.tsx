import { useState } from "react";
import { Check } from "lucide-react";
import type { Application } from "../../shared/types";
import { entityUrl } from "../shell/entity-url";
import { stageLabel, stageNames } from "./stages";
import type { Mutate } from "../workspace/workspace-actions";
import { Select } from "../ui/Select";

export function ApplicationTracking({
  application: a,
  mutate,
  justSaved,
  onSaved,
}: {
  application: Application;
  mutate: Mutate;
  justSaved: boolean;
  onSaved: (version: number) => void;
}) {
  const [form, setForm] = useState({ status: a.status, nextAction: a.nextAction || "", followUp: a.followUp || "" });
  const [saving, setSaving] = useState(false);
  const dirty = form.status !== a.status || form.nextAction !== (a.nextAction || "") || form.followUp !== (a.followUp || "");
  const set = (key: keyof typeof form, value: string) => setForm(f => ({ ...f, [key]: value }));
  return (
    <form
      className="form-stack opening-application-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        mutate(entityUrl("/api/applications", a.id), { expectedVersion: a.version, ...form }, "PATCH")
          .then(saved => onSaved(Number(saved?.version)))
          .catch(() => {})
          .finally(() => setSaving(false));
      }}
    >
      <div className="opening-application-fields">
        <Select
          label="Stage"
          value={form.status}
          onChange={(v) => set("status", v)}
          options={stageNames
            .filter((s) => s !== "applied" || !!a.submittedAt)
            // Select options are fixed two-item value/label tuples.
            .map((s) => [s, stageLabel(s)] as [string, string])}
        />
        <label>
          Next action
          <input value={form.nextAction} onChange={(e) => set("nextAction", e.target.value)} placeholder="What moves this forward?" />
        </label>
        <label>
          Follow-up
          <input type="date" value={form.followUp} onChange={(e) => set("followUp", e.target.value)} />
        </label>
      </div>
      <button className="button secondary small-button" disabled={saving || !dirty}>
        {saving ? "Saving…" : !dirty && justSaved ? <><Check size={14} /> Saved</> : "Save"}
      </button>
    </form>
  );
}
