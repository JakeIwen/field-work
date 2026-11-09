import type { MutableRefObject } from "react";
import { ExternalLink } from "lucide-react";
import { hostedApplication } from "../../shared/application-host";
import type { Opening } from "../../shared/types";
import { isPlainClick } from "../ui/AppLink";
import type { AutofillTabLauncher } from "./autofill/greenhouse-tab-autofill";
import { entityUrl } from "../shell/entity-url";

export default function OpeningPostingLink({ opening, autofillLauncher }: {
  opening: Opening;
  autofillLauncher?: MutableRefObject<AutofillTabLauncher | undefined>;
}) {
  const greenhouse = hostedApplication(opening.url)?.provider === "greenhouse";
  const href = greenhouse ? `${entityUrl("/api/openings", opening.id)}/application` : opening.url;
  return <a className="opening-title-link" href={href} target="_blank" rel="noreferrer"
    title={greenhouse ? "Opens the application form. With a current autofill script and the Fieldwork userscript (automation/greenhouse/fieldwork-autofill.user.js) installed, the script runs in that tab and submission is recorded, as Copy does. Cmd/Ctrl-click opens the form without it." : undefined}
    onClick={event => {
      const launch = autofillLauncher?.current;
      if (!launch || !isPlainClick(event)) return;
      // Unlike the link, window.open keeps the opener handle the userscript answers through.
      const tab = window.open(href, "_blank");
      if (!tab) return;
      event.preventDefault();
      launch(tab);
    }}>
    {opening.title} <ExternalLink size={18} aria-hidden="true" />
  </a>;
}
