import { useEffect, useState } from "react";
import { LoaderCircle, Mail, MailCheck, MailWarning } from "lucide-react";
import AppLink from "../ui/AppLink";
import { followUpEligible, type ApplicationFollowUpSummary } from "../../shared/follow-up-email";
import type { Application } from "../../shared/types";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { type Go, type Notify } from "../workspace/workspace-actions";
import "./follow-up.css";

/** The Follow-up column's email action: draft one in place, then open it on the Application. */
export function FollowUpEmailButton({
  application,
  followUp,
  label,
  go,
  notify,
}: {
  application: Application;
  followUp?: ApplicationFollowUpSummary;
  label: string;
  go: Go;
  notify: Notify;
}) {
  const [starting, setStarting] = useState(false);
  // Keep the spinner until the refreshed record shows the draft request.
  useEffect(() => setStarting(false), [followUp?.version]);
  if (!followUpEligible(application)) return null;
  const drafting = starting || followUp?.generation?.status === "drafting";
  if (drafting)
    return (
      <span className="follow-up-icon is-busy" role="status" aria-label={`Drafting follow-up email for ${label}`} title="Drafting follow-up email">
        <LoaderCircle size={15} className="spin" aria-hidden="true" />
      </span>
    );
  const sent = followUp?.sent.at(-1);
  if (followUp?.draft || followUp?.generation?.status === "failed" || sent) {
    const failed = !followUp?.draft && followUp?.generation?.status === "failed";
    const text = failed
      ? `Follow-up draft failed for ${label}; open to retry`
      : sent
        ? `Follow-up sent ${formatDate(sent.at)} for ${label}; open`
        : `Open follow-up email draft for ${label}`;
    const Icon = failed || followUp?.sending?.uncertain ? MailWarning : sent ? MailCheck : Mail;
    return (
      <AppLink className={`follow-up-icon ${sent ? "is-sent" : "has-draft"}`} go={go} page="applications" id={application.id} aria-label={text} title={text}>
        <Icon size={15} aria-hidden="true" />
      </AppLink>
    );
  }
  return (
    <button
      type="button"
      className="follow-up-icon"
      aria-label={`Draft follow-up email for ${label}`}
      title="Draft follow-up email"
      onClick={() => {
        setStarting(true);
        api(`${entityUrl("/api/applications", application.id)}/follow-up/draft`, {})
          .then(() => notify(`Drafting a follow-up email for ${label}`))
          .catch((cause: Error) => {
            setStarting(false);
            notify(cause.message);
          });
      }}
    >
      <Mail size={15} aria-hidden="true" />
    </button>
  );
}
