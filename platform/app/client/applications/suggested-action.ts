import type { Application } from "../../shared/types";
import { formatDate } from "../ui/dates";

/** A stage-derived hint shown when no next action is saved. Never persisted. */
export function suggestedAction(a: Application) {
  switch (a.status) {
    case "considering": return "Generate documents";
    case "preparing": return "Wait for documents";
    case "ready": return "Submit the application";
    case "applied": return a.followUp ? `Follow up · ${formatDate(a.followUp)}` : "Set a follow-up date";
    case "interviewing": return "Prepare for the interview";
    default: return "";
  }
}
