import AppLink from "../ui/AppLink";
import { openingVisibleInList } from "../../shared/opening-availability";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import type { AppState } from "../../shared/types";
import { textMatch } from "../ui/text-match";
import type { Go } from "../workspace/workspace-actions";

export function GlobalSearch({
  state,
  query,
  go,
}: {
  state: AppState;
  query: string;
  go: Go;
}) {
  const [includeClosed, setIncludeClosed] = useState(false);
  const roles = state.openings.filter((o) =>
    openingVisibleInList(o, { closed: includeClosed, history: true }) && textMatch(
      query,
      o.company,
      o.title,
      o.why,
      o.requirements,
      state.personal[o.id]?.notes,
    ),
  );
  const companies = state.companies.filter((c) =>
    textMatch(query, c.name, c.text, state.personal[c.id]?.notes),
  );
  const docs = state.documents.filter((d) =>
    textMatch(query, d.name, d.path, d.text),
  );
  const apps = state.applications.filter((a) =>
    textMatch(
      query,
      a.notes,
      a.contacts,
      a.nextAction,
      state.openings.find((o) => o.id === a.openingId)?.company,
    ),
  );
  return (
    <div className="search-results">
      <label className="check-label"><input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} /> Include closed / removed openings</label>
      {[
        ["Openings", roles, "openings"],
        ["Companies", companies, "companies"],
        ["Documents", docs, "documents"],
        ["Applications", apps, "applications"],
      ].map(([label, items, page]: any) => (
        <section className="panel" key={label}>
          <div className="section-heading">
            <h2>
              {label} <span className="muted">{items.length}</span>
            </h2>
          </div>
          {items.slice(0, 20).map((item: any) => (
            <AppLink
              key={item.id}
              className="search-result"
              go={go} page={page} id={item.id}
            >
              <span>
                <strong>
                  {item.title ||
                    item.name ||
                    state.openings.find((o) => o.id === item.openingId)
                      ?.company ||
                    "Application"}
                </strong>
                <small>
                  {item.company ||
                    item.path ||
                    item.nextAction}
                </small>
              </span>
              <ArrowRight size={16} />
            </AppLink>
          ))}
          {!items.length && (
            <div className="quiet-empty small">
              No matching {String(label).toLowerCase()}.
            </div>
          )}
          {items.length > 20 && (
            <div className="quiet-empty small">
              Showing the first 20 results. Refine your search for more specific
              matches.
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
