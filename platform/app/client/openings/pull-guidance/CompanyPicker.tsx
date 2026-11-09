import { useMemo, useState } from "react";
import { greenhouseCompanyFilterLimits, greenhouseCompanyKey } from "../../../shared/greenhouse-company-filter";
import { GuidancePopup } from "./GuidancePopup";
import { GuidanceTransfer, type TransferSide } from "./GuidanceTransfer";
import { guidanceCompanyOptions, type CompanyState } from "./company-options";

export function CompanyPicker({ state, initial, onApply, onClose }: {
  state: CompanyState; initial: string[]; onApply: (companies: string[]) => void; onClose: () => void;
}) {
  const [excluded, setExcluded] = useState(initial);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const { companies, countExcluded } = useMemo(() => guidanceCompanyOptions(state, includeArchived), [state.openings, state.personal, includeArchived]);
  const keys = new Set(excluded.map(greenhouseCompanyKey));
  function add(value: string) {
    const entry = value.trim();
    const key = greenhouseCompanyKey(entry);
    if (!key || entry.length > greenhouseCompanyFilterLimits.length || /[\u0000-\u001f\u007f]/.test(entry)) { setError(`Enter a company name or board token up to ${greenhouseCompanyFilterLimits.length} characters.`); return; }
    if (keys.has(key)) { setError("That company is already excluded."); return; }
    if (excluded.length >= greenhouseCompanyFilterLimits.count) { setError(`You can exclude up to ${greenhouseCompanyFilterLimits.count} companies.`); return; }
    setExcluded([...excluded, entry]); setName(""); setError("");
  }
  function move(id: string, to: TransferSide) {
    if (to === "left") { setExcluded(excluded.filter(entry => greenhouseCompanyKey(entry) !== id)); setError(""); }
    else { const company = companies.find(entry => entry.id === id); if (company) add(company.label); }
  }
  const available = companies.filter(company => !keys.has(company.id) && !company.boards.some(board => keys.has(greenhouseCompanyKey(board))) && company.label.toLowerCase().includes(filter.toLowerCase()));
  return <GuidancePopup title="Excluded companies" onClose={onClose}>
    <label className="guidance-popup-filter">Filter companies<input type="search" value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <label className="checkbox-label"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />Include archived</label>
    <GuidanceTransfer
      left={{ title: "Companies", empty: filter ? "No companies match this filter." : "No available companies.", items: available.map(company => ({ ...company, detail: openingCount(company.count), moveDisabled: excluded.length >= greenhouseCompanyFilterLimits.count })) }}
      right={{ title: `Excluded (${excluded.length})`, empty: "No excluded companies.", items: excluded.map(label => ({ id: greenhouseCompanyKey(label), label, detail: openingCount(countExcluded(label)) })) }}
      moveLabel={(item, to) => to === "right" ? `Exclude ${item.label}` : `Include ${item.label}`} onMove={move} />
    <form className="guidance-popup-add" onSubmit={event => { event.preventDefault(); add(name); }}>
      <label htmlFor="guidance-company-name">Company name or Greenhouse board token</label>
      <input id="guidance-company-name" value={name} maxLength={greenhouseCompanyFilterLimits.length} onChange={event => setName(event.target.value)} />
      <button className="button secondary" disabled={!name.trim()}>Add</button>
    </form>
    {error && <p className="intake-error" role="alert">{error}</p>}
    <div className="guidance-popup-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={() => onApply(excluded)}>Apply</button></div>
  </GuidancePopup>;
}

const openingCount = (count: number) => `${count} Opening${count === 1 ? "" : "s"}`;
