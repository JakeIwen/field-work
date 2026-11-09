import type { FormEventHandler } from "react";
import type { Application } from "../../shared/types";
import { stageLabel, stageNames } from "./stages";
import { Select } from "../ui/Select";

export type ApplicationStageFields = Pick<
  Application,
  "status" | "nextAction" | "followUp" | "contacts" | "notes"
>;

type ApplicationStageFormProps = {
  form: ApplicationStageFields;
  submitted: boolean;
  suggestedActionText?: string;
  onChange: (key: keyof ApplicationStageFields, value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

export function ApplicationStageForm({
  form,
  submitted,
  suggestedActionText,
  onChange,
  onSubmit,
}: ApplicationStageFormProps) {
  return (
    <form className="form-stack" onSubmit={onSubmit}>
      <Select
        label="Application stage"
        value={form.status}
        onChange={(value) => onChange("status", value)}
        options={stageNames
          .filter((stage) => stage !== "applied" || submitted)
          // Select options are fixed two-item value/label tuples.
          .map((stage) => [stage, stageLabel(stage)] as [string, string])}
      />
      <label>
        Next action
        <input
          value={form.nextAction}
          onChange={(event) => onChange("nextAction", event.target.value)}
          placeholder="What moves this forward?"
          aria-describedby={!form.nextAction && suggestedActionText ? "application-suggested-action" : undefined}
        />
      </label>
      {!form.nextAction && suggestedActionText && (
        <span id="application-suggested-action" className="suggested-action small">Suggested: {suggestedActionText}</span>
      )}
      <label>
        Follow-up date
        <input
          type="date"
          value={form.followUp}
          onChange={(event) => onChange("followUp", event.target.value)}
        />
      </label>
      <label>
        Contacts
        <textarea
          rows={2}
          value={form.contacts}
          onChange={(event) => onChange("contacts", event.target.value)}
          placeholder="Name, role, contact information"
        />
      </label>
      <label>
        Notes
        <textarea
          rows={3}
          value={form.notes}
          onChange={(event) => onChange("notes", event.target.value)}
          placeholder="Conversations, questions, and decisions"
        />
      </label>
      <button className="button primary">Save application</button>
    </form>
  );
}
