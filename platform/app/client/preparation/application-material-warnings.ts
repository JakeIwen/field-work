import { preparationDocumentKinds, preparationDocumentsSaved, type ApplicationPreparation, type PreparationPhase } from "../../shared/application-preparation";
import { errorSummary } from "../ui/ErrorNotice";
import { postingGoneNotice } from "../../shared/opening-availability";

const stoppedPhase: Record<PreparationPhase, string> = {
  queued: "Preparation stopped before it started.",
  form: "Application form inspection stopped.",
  documents: "Document generation stopped.",
  answers: "Written-answer preparation stopped.",
  packaging: "Autofill script preparation stopped.",
  ready: "Preparation stopped before it finished.",
};

type SavedMaterial = { stale?: boolean; staleReasons?: string[]; scope?: ApplicationPreparation["scope"] };

/**
 * Once an application is submitted its package is already sent, so changes since then (writing
 * rules, resume, profile, posting) are noise on its Opening (owner, 2026-10-20). Display only:
 * the server's stale flags still decide what Generate Docs replaces.
 */
export function sentMaterial<T extends SavedMaterial>(material: T | undefined, submitted: boolean): T | undefined {
  // An answers-only run is a new draft, not the application's immutable sent package.
  return submitted && material?.scope !== "answers" && material?.stale ? { ...material, stale: false, staleReasons: [] } : material;
}

/** Shared wording for the list's generation control and the Opening warning. */
export function applicationMaterialWarnings(run?: ApplicationPreparation, saved?: SavedMaterial, error = "") {
  const failure = error || (run?.status === "failed" ? run.error || run.message : "");
  const stopped = !!failure || run?.status === "paused";
  const stale = run?.stale || saved?.stale;
  if (!stopped && !stale) return [];
  const details: string[] = [];
  if (failure) {
    const withoutRole = failure.replace(/^[^\n]+ · [^\n]+?: /, "");
    details.push(/Your saved profile changed/.test(withoutRole)
      ? "Saved profile answers changed."
      : errorSummary(withoutRole, "Generation did not finish. Open Revise for details."));
  } else if (run?.status === "paused") details.push(run.message);
  details.push(...run?.staleReasons ?? [], ...saved?.staleReasons ?? []);
  if (stale && !details.length) details.push("Saved materials no longer match their current source data.");
  const status = stopped ? (run ? stoppedPhase[run.phase] : "Preparation stopped before it finished.") : "Saved materials need updating.";
  if (stopped && run?.documentIds.length)
    details.unshift(!preparationDocumentsSaved(run) ? "One PDF is saved; document preparation is incomplete."
      : preparationDocumentKinds(run).length > 1 ? "Resume and cover letter PDFs are saved." : "The resume PDF is saved.");
  // A closed posting has no form left to continue; its message names the next step.
  if (failure.includes(postingGoneNotice)) return [status, ...new Set(details)];
  const action = stopped ? "Use Generate Docs to continue from saved work." : "Use the refresh controls to update saved materials.";
  return [status, ...new Set(details), action];
}
