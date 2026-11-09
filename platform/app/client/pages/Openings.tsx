import { OpeningFormActions } from "../openings/OpeningFormActions";
import { OpeningBulkActions } from "../openings/OpeningBulkActions";
import OpeningApplication from "../openings/OpeningApplication";
import OpeningPostingLink from "../openings/OpeningPostingLink";
import type { AutofillTabLauncher } from "../openings/autofill/greenhouse-tab-autofill";
import OpeningQuestions from "../openings/OpeningQuestions";
import OpeningResearch from "../openings/research/OpeningResearch";
import CompanyContact from "../openings/CompanyContact";
import OpeningSavedFiles from "../openings/OpeningSavedFiles";
import { DismissOpeningButton, useOpeningDismissal } from "../openings/opening-dismissal";
import DeleteRecord from "../ui/DeleteRecord";
import { hostedApplication } from "../../shared/application-host";
import { appliedOpeningIds } from "../../shared/opening-applications";
import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import { openingListSummary } from "../../shared/opening-list";
import { isClosedOpening, openingAvailability, validationLabel } from "../../shared/opening-availability";
import { openingAssessmentValues, openingAssessmentValuesFor, openingAssessmentDetails } from "../../shared/opening-assessments";
import { openingSort, openingSortOptions, openingSortStorageKey, sortOpenings, openingPostedDate, openingAddedDate } from "../openings/opening-sort";
import { useEffect, useRef, useState } from "react";
import { OpeningActions } from "../openings/OpeningWorkflow";
import OpeningIntake from "../openings/OpeningIntake";
import { ArrowRight, Bookmark, Check, GitCompareArrows, Search, X, AlertTriangle } from "lucide-react";
import type { AppState, Opening } from "../../shared/types";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { stageLabel } from "../applications/stages";
import type { Go, Mutate, Notify } from "../workspace/workspace-actions";
import OpeningAgeFilter from "../openings/OpeningAgeFilter";
import { emptyOpeningFilters, matchesOpeningFilters, normalizeOpeningFilters, openingReviewOptions } from "../openings/opening-filters";
import { OpeningSkillsFilter } from "../openings/skills/OpeningSkillsFilter";
import { OpeningSkillChips } from "../openings/skills/OpeningSkillChips";
import { OpeningSkillsSortHeader } from "../openings/skills/OpeningSkillsSortHeader";
import { emptySkillFilter } from "../openings/skills/opening-skill-filter";
import { useOpeningListKeyboard, useOpeningRangeSelection } from "../openings/useOpeningListInteraction";
import { Rich } from "../ui/Rich";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";
import { Field } from "../ui/Field";
import { Source } from "../ui/Source";
import { SearchBox } from "../ui/SearchBox";
import { Select } from "../ui/Select";
import { MultiSelect } from "../ui/MultiSelect";
import "../openings/openings.css";


const normalizedTitle = (title: string) =>
  String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Short posting reference used to tell apart same-company, same-title rows. */
function postingReference(o: Opening) {
  const hosted = hostedApplication(o.url);
  if (hosted?.provider === "greenhouse") return `#${hosted.jobId}`;
  if (hosted) return hosted.postingId.slice(0, 8);
  try {
    const url = new URL(o.url);
    const ghJid = url.searchParams.get("gh_jid");
    if (ghJid && /^\d+$/.test(ghJid)) return `#${ghJid}`;
    if (/(^|\.)greenhouse\.io$/.test(url.hostname)) {
      const id = /\/jobs\/(\d+)/.exec(url.pathname)?.[1];
      if (id) return `#${id}`;
    }
    if (/(^|\.)myworkday(jobs|site)\.com$/.test(url.hostname)) {
      const last = url.pathname.split("/").filter(Boolean).pop() || "";
      const id = /_([A-Za-z]{0,4}-?\d[\w-]*)$/.exec(last)?.[1];
      if (id) return id;
    }
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(url.pathname)?.[0];
    if (uuid) return uuid.slice(0, 8);
  } catch { /* Fall back to the opening id below. */ }
  return `id …${o.id.slice(-6)}`;
}
/** References for rows whose company and normalized title collide with another visible row. */
function duplicateReferences(rows: Opening[]) {
  const groups = new Map<string, Opening[]>();
  for (const o of rows) {
    const key = `${String(o.company).toLowerCase().trim()}|${normalizedTitle(o.title)}`;
    groups.set(key, [...(groups.get(key) || []), o]);
  }
  const refs = new Map<string, string>();
  for (const group of groups.values())
    if (group.length > 1) for (const o of group) refs.set(o.id, postingReference(o));
  return refs;
}
export function Openings({
  state,
  selected,
  go,
  personal,
  mutate,
  notify,
  refresh = async () => {},
  onVisibleCountChange,
}: {
  state: AppState;
  selected: string;
  go: Go;
  personal: (id: string, f: any) => Promise<any>;
  mutate: Mutate;
  /** Shell toast; the page falls back to its own status toast when absent. */
  notify?: Notify;
  refresh?: () => Promise<void>;
  onVisibleCountChange?: (count: number) => void;
}) {
  const [filters, setFilters] = useState(() => {
    try { return {...emptyOpeningFilters,sort:openingSort(localStorage.getItem(openingSortStorageKey))}; }
    catch { return {...emptyOpeningFilters}; }
  }),
    [selection, setSelection] = useState<string[]>([]),
    [comparing, setComparing] = useState(false),
    [toast, setToast] = useState(""),
    [focusId, setFocusId] = useState(selected),
    [filterName, setFilterName] = useState(""),
    [saveForm, setSaveForm] = useState(false);
  const set = (key: string, value: any) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const { hiddenIds, dismiss } = useOpeningDismissal(personal, filters.dismissed, id => {
    setSelection(ids => ids.filter(selectedId => selectedId !== id));
    if (selected === id) go("openings");
  }, message => notify ? notify(message) : setToast(message));
  const fitSort = filters.sort.startsWith("technical-") ? "technical"
    : filters.sort.startsWith("wlb-") ? "wlb" : null;
  const nextFitSort = fitSort === "technical" ? "wlb-high" : "technical-high";
  const fitSortLabel = fitSort === "technical" ? `Technical · ${filters.sort.endsWith("low") ? "Low" : "High"} first`
    : fitSort === "wlb" ? `WLB · ${filters.sort.endsWith("low") ? "Low" : "High"} first` : "";
  useEffect(() => {
    try { localStorage.setItem(openingSortStorageKey,openingSort(filters.sort)); } catch { /* Sorting still works without browser storage. */ }
  },[filters.sort]);
  const applied = appliedOpeningIds(state.applications);
  const matchesFilters = (o: Opening, candidateFilters = filters) =>
    matchesOpeningFilters(o, candidateFilters, state.personal, applied, hiddenIds);
  const filtered = sortOpenings(state.openings.filter(o => matchesFilters(o)), filters.sort, state.openingGenerationCounts, state.openingAutofillFinishCounts, state.knownSkills, state.openingAutofillAnswerCounts);
  useEffect(() => { onVisibleCountChange?.(filtered.length); }, [filtered.length, onVisibleCountChange]);
  const skillCandidates = state.openings.filter(o => matchesFilters(o, { ...filters, skills: emptySkillFilter }));
  const visibilityReveals = [
    { key: "applied" as const, label: "applied" },
    { key: "dismissed" as const, label: "not interested" },
    { key: "closed" as const, label: "closed / removed" },
    { key: "history" as const, label: "not confirmed open" },
  ].map(item => ({
    ...item,
    count: state.openings.filter(o =>
      !matchesFilters(o) && matchesFilters(o, { ...filters, [item.key]: true })
    ).length,
  })).filter(item => !filters[item.key] && item.count > 0);
  const chosen = state.openings.find((o) => o.id === selected);
  const selectedSet = new Set(selection);
  const visibleSelected = filtered.filter(o => selectedSet.has(o.id)).length;
  const hiddenSelected = selection.length - visibleSelected;
  const canCompare = selection.length >= 2 && selection.length <= 3;
  const duplicateRefs = duplicateReferences(filtered);
  const { toggleSelected, resetSelectionAnchor } = useOpeningRangeSelection(filtered, setSelection);
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = visibleSelected > 0 && visibleSelected < filtered.length;
  });
  useEffect(() => { if (selected) setFocusId(selected); }, [selected]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!selected) return;
    document.querySelector(`tr[data-opening-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useOpeningListKeyboard({ rows: filtered, focusId, chosenId: chosen?.id, comparing, go, setFocusId, setComparing, setSelection });

  return (
    <div className={`opening-page ${chosen ? "opening-selected" : ""}`}>
      <OpeningIntake state={state} mutate={mutate} go={go} />
      <div className="filter-panel">
        <div className="filter-top">
          <SearchBox
            value={filters.query}
            onChange={(v) => set("query", v)}
            placeholder="Search company, role, or technology…"
          />
          <label className="opening-sort">
            <span>Sort by</span>
            <select aria-label="Sort opportunities" value={openingSort(filters.sort)} onChange={e=>set("sort",e.target.value)}>
              {openingSortOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="opening-sort" title="Postings whose hosted application form Fieldwork can fill."><span>Autofill</span>
            <select aria-label="Autofill support" value={filters.nonGreenhouse ? "unsupported" : filters.autofillEligible ? "supported" : "all"}
              onChange={e => setFilters(f => ({ ...f, autofillEligible: e.target.value === "supported", nonGreenhouse: e.target.value === "unsupported" }))}>
              <option value="all">All openings</option><option value="supported">Autofill eligible</option><option value="unsupported">Not autofill-eligible</option>
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={filters.saved}
              onChange={(e) => set("saved", e.target.checked)}
            />{" "}
            <Bookmark size={14} /> Saved only
          </label>
          <button
            className="button secondary small-button"
            onClick={() => setSaveForm(!saveForm)}
          >
            Save filter
          </button>
          {state.savedFilters.length > 0 && (
            <select
              aria-label="Load saved filter"
              value=""
              onChange={(e) => {
                const f = state.savedFilters.find(
                  (f) => f.id === e.target.value,
                );
                if (f) setFilters(normalizeOpeningFilters(f.filters));
              }}
            >
              <option value="">Saved filters</option>
              {state.savedFilters.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <OpeningSkillsFilter openings={skillCandidates} value={filters.skills} onChange={value => set("skills", value)} />
        <details className="opening-filters"><summary>More filters</summary>{state.savedFilters.length > 0 && <details><summary>Manage saved filters</summary>{state.savedFilters.map(f => <div className="record-with-delete" key={f.id}><span>{f.name}</span><DeleteRecord kind="filter" id={f.id} label={f.name} /></div>)}</details>}
        <div className="filter-bottom">
          <MultiSelect
            label="Technical fit"
            value={filters.technical}
            onChange={(v) => set("technical", v)}
            emptyLabel="Any technical fit"
            options={openingAssessmentValues}
          />
          <MultiSelect
            label="Remote fit"
            value={filters.remote}
            onChange={(v) => set("remote", v)}
            emptyLabel="Any remote fit"
            options={openingAssessmentValues}
          />
          <MultiSelect
            label="WLB outlook"
            value={filters.wlb}
            onChange={(v) => set("wlb", v)}
            emptyLabel="Any WLB outlook"
            options={openingAssessmentValues}
          />
          <Select
            label="Published pay"
            value={filters.pay}
            onChange={(v) => set("pay", v)}
            options={[
              ["", "All compensation"],
              ["published", "Published annual USD base"],
              ["200000", "Any USD base band reaches $200k"],
              ["150000", "Any USD base band reaches $150k"],
              ["100000", "Any USD base band reaches $100k"],
              ["unknown", "No annual USD base figure"],
            ]}
          />
          <MultiSelect
            label="My review"
            value={filters.review}
            onChange={(v) => set("review", v)}
            emptyLabel="Any review state"
            options={openingReviewOptions}
          />
          <OpeningAgeFilter filters={filters} set={set} />
          <button
            className="text-button clear-filter"
            onClick={() => setFilters(emptyOpeningFilters)}
          >
            Reset
          </button>
        </div>
        </details>
        {saveForm && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              mutate("/api/filters", { name: filterName, filters })
                .then(() => {
                  setSaveForm(false);
                  setFilterName("");
                })
                .catch(() => {});
            }}
          >
            <input
              required
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
              placeholder="Give this filter a name"
              aria-label="Filter name"
            />
            <button className="button primary small-button">Save filter</button>
          </form>
        )}
      </div>
      <div className="results-bar">
        <span className="opening-results-count">
          <strong>{filtered.length}</strong>{" "}
          {filtered.length === 1 ? "opportunity" : "opportunities"}
        </span>
        <div>
          <label className="check-label small">
            <input type="checkbox" checked={filters.applied} onChange={e => set("applied", e.target.checked)} />{" "}
            Include applied
          </label>
          <label className="check-label small">
            <input type="checkbox" checked={filters.closed} onChange={e => set("closed", e.target.checked)} />{" "}
            Include closed / removed
          </label>
          <label className="check-label small">
            <input
              type="checkbox"
              checked={filters.history}
              onChange={(e) => set("history", e.target.checked)}
            />{" "}
            Include not confirmed open
          </label>
          <label className="check-label small">
            <input
              type="checkbox"
              checked={filters.dismissed}
              onChange={(e) => set("dismissed", e.target.checked)}
            />{" "}
            Include not interested
          </label>
          <button
            className="text-button"
            disabled={!canCompare}
            title={canCompare ? undefined : "Select 2–3 openings to compare"}
            onClick={() => setComparing(true)}
          >
            <GitCompareArrows size={15} /> Compare ({selection.length}/3)
          </button>
        </div>
      </div>
      {comparing && canCompare && (
        <div className="comparison panel">
          <div className="section-heading">
            <h2>Compare opportunities</h2>
            <button
              className="icon-button"
              aria-label="Close comparison"
              title="Close comparison"
              onClick={() => setComparing(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="comparison-grid">
            {selection
              .map((id) => state.openings.find((o) => o.id === id))
              .filter(Boolean)
              .map((o) => (
                <div key={o!.id}>
                  <span className="eyebrow">{o!.company}</span>
                  <h3>{o!.title}</h3>
                  <Field label="Published compensation">
                    <Rich text={o!.compensation} />
                  </Field>
                  <Field label="Technical / remote / WLB">
                    {o!.technical_fit} / {o!.remote_fit} / {o!.wlb_outlook}
                  </Field>
                  <Field label="Work location">
                    <Rich text={o!.location} />
                  </Field>
                  <Field label="Concerns">
                    <Rich text={o!.concerns} />
                  </Field>
                </div>
              ))}
          </div>
        </div>
      )}
      <OpeningBulkActions state={state} selection={selection} setSelection={setSelection}
        showDismissed={filters.dismissed} refresh={refresh}
        announce={message => notify ? notify(message) : setToast(message)}
        hiddenSelected={hiddenSelected} visibleIds={filtered.map(o => o.id)} />
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      <div className={`master-detail ${chosen ? "has-detail" : ""}`}>
        <section className="panel table-panel">
          <div className="table-scroll openings-table-scroll">
            <table className="openings-table" aria-label="Opportunities" aria-describedby="opening-keyboard-hint">
              <colgroup>
                <col className="opening-check-col"/>
                <col className="opening-opportunity-col"/>
                <col className="opening-fit-col"/>
                {!chosen && <col className="opening-skills-col"/>}
                {!chosen && <><col className="opening-date-col"/><col className="opening-date-col"/></>}
                <col className="opening-save-col"/>
              </colgroup>
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <input
                      ref={selectAll}
                      type="checkbox"
                      aria-label="Select all visible openings"
                      checked={filtered.length > 0 && visibleSelected === filtered.length}
                      disabled={!filtered.length}
                      onChange={(e) => {
                        resetSelectionAnchor();
                        const visible = new Set(filtered.map(o => o.id));
                        setSelection(ids => e.target.checked
                          ? [...ids, ...filtered.map(o => o.id).filter(id => !ids.includes(id))]
                          : ids.filter(id => !visible.has(id)));
                      }}
                    />
                  </th>
                  <th aria-sort={filters.sort === "company" ? "ascending" : filters.sort === "company-desc" ? "descending" : "none"}>
                    <button className="opening-sort-header"
                      title="Sort by company name"
                      aria-label={`Sort by company: ${filters.sort === "company" ? "Z–A" : "A–Z"}`}
                      onClick={()=>set("sort",filters.sort === "company" ? "company-desc" : "company")}>
                      Opportunity<span aria-hidden="true">{filters.sort === "company" ? "↑" : filters.sort === "company-desc" ? "↓" : "↕"}</span>
                    </button>
                  </th>
                  <th aria-sort={!fitSort ? "none" : filters.sort.endsWith("low") ? "ascending" : "descending"}>
                    <button className="opening-sort-header opening-fit-sort-header"
                      title="Cycle sorting: Technical fit → WLB outlook"
                      aria-label={`Fit. ${fitSortLabel ? `Sorted by ${fitSortLabel}. ` : ""}Sort next by ${nextFitSort === "technical-high" ? "technical fit" : "WLB outlook"}`}
                      onClick={()=>set("sort",nextFitSort)}>
                      <span>Fit <span aria-hidden="true">↻</span></span>
                      {fitSortLabel && <span className="opening-fit-sort-label">{fitSortLabel}</span>}
                    </button>
                  </th>
                  {!chosen && <OpeningSkillsSortHeader sort={openingSort(filters.sort)} onSort={value => set("sort", value)} />}
                  {!chosen && [
                    {label:"Posted",asc:"posted-oldest",desc:"posted-newest",initial:"posted-newest",hint:"Employer's original publication date"},
                    {label:"Added",asc:"oldest",desc:"newest",initial:"newest",hint:"Date added to Fieldwork; ≈ indicates a first-seen fallback"},
                  ].map(({label,asc,desc,initial,hint})=>{
                    const direction=filters.sort===asc?"ascending":filters.sort===desc?"descending":"none";
                    const next=filters.sort===asc?desc:filters.sort===desc?asc:initial;
                    return <th key={label} aria-sort={direction} title={hint}>
                      <button className="opening-sort-header" onClick={()=>set("sort",next)} aria-label={`Sort by ${label.toLowerCase()}: ${next===asc?"oldest first":"newest first"}`}>
                        {label}<span aria-hidden="true">{direction==="ascending"?"↑":direction==="descending"?"↓":"↕"}</span>
                      </button>
                    </th>;
                  })}
                  <th aria-sort={filters.sort === "autofill-ready" ? "ascending" : "none"}>
                    <button className="opening-sort-header"
                      title="Fewest items to finish first, including answers-only drafts; complete scripts win ties, blanks last. Click again for generated docs first."
                      aria-label={filters.sort === "autofill-ready" ? "Sorted by autofill, fewest items to finish first. Sort by generated docs first" : "Sort by autofill: fewest items to finish on the application first"}
                      onClick={()=>set("sort",filters.sort === "autofill-ready" ? "docs-first" : "autofill-ready")}>
                      Autofill<span aria-hidden="true">{filters.sort === "autofill-ready" ? "↑" : "↕"}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const p = state.personal[o.id] || {};
                  const summary = openingListSummary(o);
                  const posted = openingPostedDate(o);
                  const added = openingAddedDate(o);
                  return (
                    <tr
                      key={o.id}
                      data-opening-id={o.id}
                      onFocus={() => setFocusId(o.id)}
                      aria-selected={focusId === o.id}
                      className={`${chosen?.id === o.id ? "selected" : ""} ${focusId === o.id ? "row-focus" : ""} ${selectedSet.has(o.id) ? "row-checked" : ""}`}
                    >
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          aria-label={`Select ${o.company} ${o.title}`}
                          checked={selectedSet.has(o.id)}
                          onChange={(e) => toggleSelected(o.id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                        />
                      </td>
                      <td>
                        <AppLink
                          className="table-role"
                          go={go} page={"openings"} id={o.id}
                        >
                          <span className="row-company">{o.company}</span>
                          <strong>
                            {o.title}
                            {duplicateRefs.has(o.id) && (
                              <span className="opening-dup-ref" title="Posting reference, shown because another listed opening has the same company and title">
                                {" "}{duplicateRefs.get(o.id)}
                              </span>
                            )}
                          </strong>
                          {(isClosedOpening(o) || o.validation?.status === "unknown") && <span className="small muted">{isClosedOpening(o) ? "Closed / removed" : "Could not verify"}</span>}
                          <span className="small muted line-clamp opening-list-location" title={o.location}>
                            {summary.location}
                          </span>
                        </AppLink>
                      </td>
                      <td className="opening-fit-cell">
                        <div className="opening-fit-heading">
                          <span className="opening-review">
                            {p.dismissed ? (
                              <Badge tone="muted">Not interested</Badge>
                            ) : p.reviewedHash && p.reviewedHash !== o.hash ? (
                              <Badge tone="amber">Changed since review</Badge>
                            ) : !p.reviewedHash ? (
                              <span className="unreviewed">Unreviewed</span>
                            ) : (
                              <span className="small muted">Reviewed</span>
                            )}
                          </span>
                        </div>
                        <div className="fit-mini" title={openingAssessmentDetails(o).technicalFit}>
                          Technical <b>{openingAssessmentValuesFor(o).technicalFit}</b>
                        </div>
                        <div className="fit-mini" title={openingAssessmentDetails(o).wlbOutlook}>
                          WLB <b>{openingAssessmentValuesFor(o).wlbOutlook}</b>
                        </div>
                      </td>
                      {!chosen && (
                        <td className="opening-skills-cell">
                          <OpeningSkillChips opening={o} filter={filters.skills} knownSkills={state.knownSkills} />
                        </td>
                      )}
                      {!chosen && <><td className="opening-date-cell" title={posted ? `Employer publication: ${posted}` : "Publication date unknown"}>
                        {posted ? <time dateTime={posted}>{formatDate(posted)}</time> : "Unknown"}
                      </td>
                      <td className="opening-date-cell" title={`${added.provenance}${added.value ? `: ${added.value}` : ""}`}>
                        {added.value ? <time dateTime={added.value}>{added.approximate ? "≈ " : ""}{formatDate(added.value)}</time> : "Unknown"}
                      </td>
                      </>}
                      <td>
                        <div className="opening-row-actions">
                          <div className="opening-row-actions-top">
                            <button
                              className={`icon-button bookmark ${p.saved ? "saved" : ""}`}
                              aria-label={`${p.saved ? "Unsave" : "Save"} ${o.company} ${o.title}`}
                              aria-pressed={!!p.saved}
                              title={p.saved ? "Unsave" : "Save"}
                              onClick={() =>
                                personal(o.id, { saved: !p.saved }).catch(() => {})
                              }
                            >
                              <Bookmark
                                size={17}
                                fill={p.saved ? "currentColor" : "none"}
                              />
                            </button>
                            <DismissOpeningButton id={o.id} label={`${o.company} ${o.title}`} dismiss={dismiss} />
                          </div>
                          <OpeningFormActions state={state} opening={o} submitted={applied.has(o.id)} mutate={mutate}
                            announce={message => notify ? notify(message) : setToast(message)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p id="opening-keyboard-hint" className="sr-only">
            Keyboard: Up/Down arrows or j/k move between rows, o or Enter opens the row, x selects it, Escape closes details. Shift-click checkboxes to select or clear a range.
          </p>
          {!filtered.length && (
            <Empty icon={Search} title="No roles match these filters">
              {visibilityReveals.length ? <div className="opening-empty-visibility">
                <span>Openings hidden by visibility settings:</span>
                {visibilityReveals.map(item => <button key={item.key} type="button" className="button secondary small-button" onClick={() => set(item.key, true)}>
                  Show {item.count} {item.label} {item.count === 1 ? "opening" : "openings"}
                </button>)}
              </div> : "Try a broader fit or compensation filter."}
            </Empty>
          )}
        </section>
        {chosen && (
          <OpeningDetail
            key={chosen.id}
            opening={chosen}
            state={state}
            go={go}
            personal={personal}
            mutate={mutate}
          />
        )}
      </div>
    </div>
  );
}
export function OpeningDetail({
  opening: o,
  state,
  go,
  personal,
  mutate,
}: {
  opening: Opening;
  state: AppState;
  go: Go;
  personal: (id: string, f: any) => Promise<any>;
  mutate: Mutate;
}) {
  const p = state.personal[o.id] || { version: 0 };
  const application = state.applications.find(a => a.openingId === o.id);
  const [materialTarget, setMaterialTarget] = useState<HTMLDivElement | null>(null);
  const autofillLauncher = useRef<AutofillTabLauncher | undefined>(undefined);
  // Opening an Opening counts as reviewing it (owner, 2026-10-19); a changed posting is marked again on its next open.
  // A version conflict only means another change landed first, so the next open retries.
  useEffect(() => {
    if (!o.hash || p.reviewedHash === o.hash) return;
    api(entityUrl("/api/personal", o.id), { expectedVersion: p.version || 0, reviewedHash: o.hash }).catch(() => {});
  }, [o.id, o.hash]);

  return (
    <aside className="panel detail-panel opening-detail-panel">
      <div className="opening-detail-close">
        <AppLink
          className="icon-button"
          aria-label="Close role details"
          title="Close role details"
          go={go} page={"openings"}
        >
          <X size={18} />
        </AppLink>
      </div>
      <div className="detail-heading opening-detail-heading">
        <div className="opening-materials-slot" ref={setMaterialTarget} />
        <AppLink
          className="text-button company-link"
          go={go} page={"companies"} id={o.company_id}
        >
          {o.company}
          <ArrowRight size={13} />
        </AppLink>
        <h2><OpeningPostingLink opening={o} autofillLauncher={autofillLauncher} /></h2>
        <div className="badge-row">
          <Badge
            tone={
              openingAvailability(o) === "open"
                ? "green"
                : "amber"
            }
          >
            {isClosedOpening(o) ? "Closed / removed" : o.validation ? validationLabel(o.validation.status === "unknown" ? "unknown" : openingAvailability(o)) : stageLabel(o.postingStatus || "Unknown posting status")}
          </Badge>
          <Badge tone="muted">{o.personalOpening ? "Added by you" : `Scan: ${o.status}`}</Badge>
          {Boolean(o.reviewRequired) && (
            <Badge tone="amber">Needs fit review</Badge>
          )}
        </div>
        {o.validation && <p className="small muted opening-validation-summary">
          Last availability check: <span className="opening-meta-segment">{formatDate(o.validation.checkedAt, true)}{" ·"}</span> <span className="opening-meta-segment">{o.validation.sourceUrl
            ? <a href={o.validation.sourceUrl} target="_blank" rel="noreferrer">{validationLabel(o.validation.status)}</a>
            : validationLabel(o.validation.status)}
          {o.validation.status !== "open" && o.validation.reason && <> <InfoTooltip label="About the availability result">{o.validation.reason}</InfoTooltip></>}</span>
        </p>}
        {application
          ? <div className="opening-application-meta"><AppLink className="text-button opening-meta-segment" go={go} page="applications" id={application.id}>Related application <ArrowRight size={13} /></AppLink>
            {application.applicationDate && <span className="small muted">Application started <strong className="opening-meta-segment">{formatDate(application.applicationDate)}{" ·"}</strong> <span className="opening-meta-segment">{application.submittedAt ? "Submitted" : "In preparation"}</span></span>}
          </div>
          : <span className="muted opening-application-meta">(Application not started)</span>}

      </div>
      <div className="detail-content">
        <OpeningActions key={`actions:${o.id}`} controlsTarget={materialTarget} autofillLauncher={autofillLauncher} opening={o} state={state} mutate={mutate} go={go} />
        <OpeningResearch opening={o} />
        <div className="section-divider" />
        <div className="row-wrap">
          <button
            className="text-button"
            onClick={() =>
              personal(o.id, { dismissed: !p.dismissed }).catch(() => {})
            }
          >
            {p.dismissed ? "Restore interest" : "Not interested"}
          </button>
        </div>
        <div className="section-divider" />
        <OpeningQuestions key={`questions:${o.id}`} opening={o} state={state} mutate={mutate} go={go} />
        <OpeningApplication opening={o} application={application} state={state} mutate={mutate} />
        <CompanyContact key={`contact:${o.id}`} opening={o} applicationDate={application?.applicationDate} />
        <OpeningSavedFiles opening={o} state={state} />
      </div>
    </aside>
  );
}
