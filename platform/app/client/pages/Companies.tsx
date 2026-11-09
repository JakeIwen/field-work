import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import { useState } from "react";
import { Building2, ChevronRight, Plus, Sparkles, X } from "lucide-react";
import type { AppState } from "../../shared/types";
import { formatDate } from "../ui/dates";
import { textMatch } from "../ui/text-match";
import { retained } from "../workspace/opening-selectors";
import { stageLabel } from "../applications/stages";
import type { Go, Mutate } from "../workspace/workspace-actions";
import type { Context } from "../agents/task-context";
import { Rich } from "../ui/Rich";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";
import { Field } from "../ui/Field";
import { Source } from "../ui/Source";
import { SearchBox } from "../ui/SearchBox";
import { Select } from "../ui/Select";
import { PersonalForm } from "../companies/PersonalForm";

export function Companies({
  state,
  selected,
  go,
  personal,
  agent,
  mutate,
}: {
  state: AppState;
  selected: string;
  go: Go;
  personal: (id: string, f: any) => Promise<any>;
  agent: (c: Partial<Context>, p?: string) => void;
  mutate: Mutate;
}) {
  const [query, setQuery] = useState(""),
    [onlyOpen, setOnlyOpen] = useState(false),
    [inactive, setInactive] = useState(false),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [url, setUrl] = useState("");
  const chosen = state.companies.find((c) => c.id === selected);
  const list = state.companies.filter(
    (c) =>
      textMatch(query, c.name, c.text) &&
      (!onlyOpen || retained(state).some((o) => o.company_id === c.id)) &&
      (inactive || state.personal[c.id]?.monitoring !== false),
  );
  return (
    <>
      <div className="filter-panel">
        <div className="filter-top">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search companies, policies, or technologies…"
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={onlyOpen}
              onChange={(e) => setOnlyOpen(e.target.checked)}
            />{" "}
            With retained openings
          </label>
          <button
            className="button primary small-button"
            onClick={() => setAdding(!adding)}
          >
            <Plus size={15} /> Add company
          </button>
        </div>
        {adding && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              mutate("/api/companies", { name, careersUrl: url })
                .then((c) => {
                  setAdding(false);
                  setName("");
                  setUrl("");
                  go("companies", c.id || c.company?.id);
                })
                .catch(() => {});
            }}
          >
            <input
              required
              aria-label="Company name"
              placeholder="Company name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              type="url"
              required
              aria-label="Official careers URL"
              placeholder="https://company.com/careers"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="button primary small-button">
              Add to my watchlist
            </button>
          </form>
        )}
      </div>
      <div className="results-bar">
        <span>
          <strong>{list.length}</strong> companies
        </span>
        <label className="check-label small">
          <input
            type="checkbox"
            checked={inactive}
            onChange={(e) => setInactive(e.target.checked)}
          />{" "}
          Include unmonitored employers
        </label>
      </div>
      <div className={`master-detail ${chosen ? "has-detail" : ""}`}>
        <section className="panel table-panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Monitoring</th>
                  <th>Openings</th>
                  {!chosen && <th>Remote & sustainability</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr
                    key={c.id}
                    className={selected === c.id ? "selected" : ""}
                  >
                    <td>
                      <AppLink
                        className="table-role"
                        go={go} page={"companies"} id={c.id}
                      >
                        <strong>{c.name}</strong>
                        <span className="small muted line-clamp">
                          {c.fields["Industry / product"] ||
                            c.fields["industry"] ||
                            "Company research"}
                        </span>
                        {state.personal[c.id]?.monitoring === false && (
                          <Badge tone="muted">
                            {state.personal[c.id]?.pendingWatchlist
                              ? "Awaiting watchlist decision"
                              : "Not monitored"}
                          </Badge>
                        )}
                      </AppLink>
                    </td>
                    <td>
                      <div className="record-with-delete"><DeleteRecord kind="company" id={c.id} label={c.name} onDeleted={() => { if (selected === c.id) go("companies"); }} /></div>
                      {c.scan && (
                        <div
                          className={`small scan-status ${/fail|partial|unknown|inaccessible|error/i.test(String(c.scan.result)) ? "warning-text" : ""}`}
                        >
                          {stageLabel(String(c.scan.result || "Unknown"))}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="opening-count">
                        {
                          retained(state).filter((o) => o.company_id === c.id)
                            .length
                        }
                      </span>
                    </td>
                    {!chosen && (
                      <td className="company-summary">
                        <Rich
                          text={c.fields["Remote compatibility"] || "Unknown"}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.length && (
            <Empty icon={Building2} title="No companies match">
              Broaden the filters or add a company explicitly.
            </Empty>
          )}
        </section>
        {chosen && (
          <aside className="panel detail-panel">
            <div className="detail-top">
              <AppLink
                className="icon-button"
                aria-label="Close company detail"
                title="Close company detail"
                go={go} page={"companies"}
              >
                <X size={18} />
              </AppLink>
            </div>
            <div className="detail-heading">
              <h2>{chosen.name}</h2>
            </div>
            <div className="detail-content">
              {Object.entries(chosen.fields)
                .filter(
                  ([k]) =>
                    k !== "Last researched",
                )
                .map(([k, v]) => (
                  <Field key={k} label={k}>
                    <Rich text={v} />
                  </Field>
                ))}
              {chosen.scan && (
                <Field label="Latest careers scan">
                  <Badge
                    tone={
                      /fail|partial|unknown|inaccessible|error/i.test(chosen.scan.result)
                        ? "amber"
                        : "muted"
                    }
                  >
                    {chosen.scan.result}
                  </Badge>
                  <p>
                    <Rich text={chosen.scan.notes} />
                  </p>
                </Field>
              )}
              {chosen.personalCompany ? <p className="small muted">Company added {formatDate(chosen.sourceDate)}</p> : <Source path={chosen.sourcePath} date={chosen.sourceDate} />}
              <div className="section-divider" />
              <h3>Retained opportunities</h3>
              {retained(state)
                .filter((o) => o.company_id === chosen.id)
                .map((o) => (
                  <AppLink
                    className="linked-row"
                    key={o.id}
                    go={go} page={"openings"} id={o.id}
                  >
                    <span>{o.title}</span>
                    <ChevronRight size={14} />
                  </AppLink>
                ))}
              {!retained(state).some((o) => o.company_id === chosen.id) && (
                <p className="small muted">
                  No qualifying role retained in the latest sources. Access
                  failures remain unknown.
                </p>
              )}
              <div className="section-divider" />
              <Select
                label="My interest"
                value={String(state.personal[chosen.id]?.interest || "")}
                onChange={(v) =>
                  personal(chosen.id, { interest: v }).catch(() => {})
                }
                options={[
                  ["", "Not assessed"],
                  ["high", "High interest"],
                  ["medium", "Keep watching"],
                  ["low", "Low interest"],
                ]}
              />
              <PersonalForm
                key={`${chosen.id}:${state.personal[chosen.id]?.version || 0}`}
                personal={state.personal[chosen.id] || { version: 0 }}
                onSave={(fields) => personal(chosen.id, fields)}
              />
              <button
                className="button secondary full-width"
                onClick={() =>
                  agent({ companyId: chosen.id }, "company-research")
                }
              >
                <Sparkles size={15} /> Prepare research refresh
              </button>
              <button
                className="text-button small"
                title="Watchlist changes preserve imported research and history."
                onClick={() =>
                  personal(chosen.id, {
                    monitoring: state.personal[chosen.id]?.monitoring === false,
                  }).catch(() => {})
                }
              >
                {state.personal[chosen.id]?.monitoring === false
                  ? "Restore to my watchlist"
                  : "Remove from my watchlist"}
              </button>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
