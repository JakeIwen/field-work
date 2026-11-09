import { useState } from "react";
import { Check } from "lucide-react";
import type { Personal } from "../../shared/types";


export function PersonalForm({
  personal: p,
  onSave,
  includeAction = false,
  showHeading = true,
}: {
  personal: Personal;
  onSave: (fields: any) => Promise<any>;
  includeAction?: boolean;
  showHeading?: boolean;
}) {
  const [notes, setNotes] = useState(String(p.notes || "")),
    [action, setAction] = useState(String(p.nextAction || "")),
    [follow, setFollow] = useState(String(p.followUp || "")),
    [saved, setSaved] = useState(false),
    [saving, setSaving] = useState(false);
  return (
    <form
      className="form-stack personal-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        onSave({
          notes,
          ...(includeAction ? { nextAction: action, followUp: follow } : {}),
        })
          .then(() => setSaved(true))
          .catch(() => {})
          .finally(() => setSaving(false));
      }}
    >
      {showHeading && <h3>Your workspace notes</h3>}
      <label>
        Notes
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setSaved(false);
          }}
          placeholder="What stands out? What still needs an answer?"
          rows={3}
        />
      </label>
      {includeAction && (
        <>
          <label>
            Next action
            <input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="One useful next step"
            />
          </label>
          <label>
            Follow-up date
            <input
              type="date"
              value={follow}
              onChange={(e) => setFollow(e.target.value)}
            />
          </label>
        </>
      )}
      <button className="button secondary" disabled={saving}>
        {saved ? (
          <>
            <Check size={14} /> Saved
          </>
        ) : saving ? (
          "Saving…"
        ) : (
          "Save personal notes"
        )}
      </button>
    </form>
  );
}
