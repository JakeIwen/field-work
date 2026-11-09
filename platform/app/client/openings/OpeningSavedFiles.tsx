import DeleteRecord from "../ui/DeleteRecord";
import { formatDate } from "../ui/dates";
import type { AppState, Opening } from "../../shared/types";
import { openingFiles } from "./OpeningWorkflow";

// File history sits at the bottom of the Opening, below the everyday workflow (owner, 2026-11-08).
export default function OpeningSavedFiles({ opening, state }: { opening: Opening; state: AppState }) {
  const files = openingFiles(state, opening.id);
  if (!files.length) return null;
  const preparation = state.preparations?.find(r => r.openingId === opening.id);
  return <details className="opening-saved-files"><summary>Saved files ({files.length})</summary>
    {preparation && <div className="small saved-preparation">Preparation history <DeleteRecord kind="application_preparation" id={preparation.id} label="application preparation" /></div>}
    {files.slice().reverse().map(d => <div key={d.id} className="small"><a href={`/api/documents/${encodeURIComponent(d.id)}/download`} download title={[d.generatedAt || d.createdAt ? `Generated ${formatDate(d.generatedAt || d.createdAt, "seconds")}` : "Generation time unavailable", d.writingRuleWarning].filter(Boolean).join("\n")}>{d.name}</a><DeleteRecord kind="document" id={d.id} label={d.name} /></div>)}
  </details>;
}
