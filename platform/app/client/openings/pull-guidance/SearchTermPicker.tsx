import { useState } from "react";
import { greenhouseGuidanceLimits, greenhouseSearchTermPoolLimit, greenhouseSuggestedSearchTerms, validGreenhouseSearchTerm } from "../../../shared/greenhouse-guidance";
import { GuidancePopup } from "./GuidancePopup";
import { GuidanceTransfer, type TransferSide } from "./GuidanceTransfer";

const termKey = (term: string) => term.trim().toLowerCase();
const builtIns = new Set(greenhouseSuggestedSearchTerms.map(termKey));
const uniqueTerms = (terms: string[]) => [...new Map(terms.map(term => [termKey(term), term])).values()];

export function SearchTermPicker({ initialTerms, initialPool, onApply, onClose }: {
  initialTerms: string[]; initialPool: string[];
  onApply: (searchTerms: string[], searchTermPool: string[]) => void; onClose: () => void;
}) {
  const [active, setActive] = useState(initialTerms);
  const [custom, setCustom] = useState(initialPool);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const pool = uniqueTerms([...greenhouseSuggestedSearchTerms, ...custom]);
  const activeKeys = new Set(active.map(termKey));
  const full = active.length >= greenhouseGuidanceLimits.searchTerms;
  function add() {
    const term = input.trim();
    if (!validGreenhouseSearchTerm(term)) { setError(`Enter a search term up to ${greenhouseGuidanceLimits.searchTerm} characters, without line breaks or control characters.`); return; }
    if (pool.some(value => termKey(value) === termKey(term))) { setError("That term is already in the pool."); return; }
    if (custom.length >= greenhouseSearchTermPoolLimit) { setError(`The custom pool is limited to ${greenhouseSearchTermPoolLimit} terms. Delete a custom term first.`); return; }
    setCustom([...custom, term]); setInput(""); setError("");
  }
  function move(id: string, to: TransferSide) {
    if (to === "right") {
      const term = pool.find(value => termKey(value) === id);
      if (full || !term || activeKeys.has(id)) return;
      setActive([...active, term]);
    } else {
      const term = active.find(value => termKey(value) === id);
      if (!term) return;
      if (!pool.some(value => termKey(value) === id)) {
        if (custom.length >= greenhouseSearchTermPoolLimit) { setError(`Delete a custom pool term before returning ${term} to the pool.`); return; }
        setCustom([...custom, term]);
      }
      setActive(active.filter(value => termKey(value) !== id));
    }
    setError("");
  }
  return <GuidancePopup title="Extra search terms" onClose={onClose}>
    <GuidanceTransfer
      left={{ title: "Pool", empty: "All pool terms are searching.", items: pool.filter(term => !activeKeys.has(termKey(term))).map(label => ({ id: termKey(label), label, removable: !builtIns.has(termKey(label)), moveDisabled: full })) }}
      right={{ title: `Searching (${active.length}/${greenhouseGuidanceLimits.searchTerms})`, empty: "No extra searches selected.", items: active.map(label => ({ id: termKey(label), label })) }}
      moveLabel={(item, to) => to === "right" ? `Search for ${item.label}` : `Return ${item.label} to pool`} onMove={move}
      onRemove={id => { setCustom(custom.filter(term => termKey(term) !== id)); setError(""); }} />
    {full && <p className="small" role="status">Search limit reached. Return a term to the pool to choose another.</p>}
    <form className="guidance-popup-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <label htmlFor="guidance-custom-term">Custom search term ({custom.length}/{greenhouseSearchTermPoolLimit})</label>
      <input id="guidance-custom-term" value={input} maxLength={greenhouseGuidanceLimits.searchTerm} onChange={event => setInput(event.target.value)} />
      <button className="button secondary" disabled={!input.trim()}>Add to pool</button>
    </form>
    {error && <p className="intake-error" role="alert">{error}</p>}
    <div className="guidance-popup-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={() => onApply(active, custom)}>Apply</button></div>
  </GuidancePopup>;
}
