import type { AppState, Opening } from "../../shared/types";
import { openingDocumentTaskBusy } from "../../shared/opening-documents";
import { GenerateDocumentsButton } from "../preparation/ApplicationPreparation";
import type { Mutate } from "../workspace/workspace-actions";
import { FormQuestionCount } from "./FormQuestionCount";

export function OpeningFormActions({ state, opening, submitted, mutate, announce }: {
  state: AppState;
  opening: Opening;
  submitted: boolean;
  mutate: Mutate;
  announce: (message: string) => void;
}) {
  return <div className="opening-row-form-actions">
    <GenerateDocumentsButton openingId={opening.id} openingUrl={opening.url} mutate={mutate}
      run={state.preparations?.find(run => run.openingId === opening.id)} submitted={submitted}
      active={openingDocumentTaskBusy(opening.id, state.tasks)} compact
      finishCount={state.openingAutofillFinishCounts?.[opening.id]} answerCount={state.openingAutofillAnswerCounts?.[opening.id]}
      announce={announce} listingLabel={`${opening.company} ${opening.title}`} />
    <FormQuestionCount result={state.openingFormChecks?.[opening.id]} />
  </div>;
}
