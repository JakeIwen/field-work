import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Opening } from "../../shared/types";
import ErrorNotice from "../ui/ErrorNotice";
import { useTextCopy } from "../ui/useTextCopy";

export default function CompanyContact({ opening, applicationDate }: { opening: Opening; applicationDate?: string }) {
  const [error, setError] = useState("");
  const { copied, copy } = useTextCopy(setError);
  const contact = opening.contact;
  const text = `${opening.company}\n${opening.title}\n${String(opening.contactInfo || opening.url)}\n${opening.url}${applicationDate ? `\nApplication started: ${applicationDate}` : ""}`;
  return <details className="opening-company-contact">
    <summary>Company contact</summary>
    <div>
      <button type="button" className="text-button" onClick={() => void copy(text, "company-contact")}>
        {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Company details copied" : "Copy company details"}
      </button>
      <p>{String(opening.contactInfo || opening.url)}</p>
      {contact?.sourceUrl && <a className="small" href={contact.sourceUrl} target="_blank" rel="noreferrer">{contact.contactType === "url" ? "Company website (address not established)" : "Contact source"}</a>}
      {error && <ErrorNotice error={error} />}
    </div>
  </details>;
}
