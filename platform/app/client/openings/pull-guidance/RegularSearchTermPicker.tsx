import { useState } from "react";
import { validGreenhouseSearchTerm } from "../../../shared/greenhouse-guidance";
import { greenhouseDefaultRegularSearchTerms, greenhousePolicyBounds } from "../../../shared/greenhouse-policy";
import InfoTooltip from "../../ui/InfoTooltip";
import { GuidancePopup } from "./GuidancePopup";
import { GuidanceTransfer, type TransferSide } from "./GuidanceTransfer";

export function RegularSearchTermPicker({ initialTerms, onApply, onClose }: {
  initialTerms: string[]; onApply: (terms: string[]) => void; onClose: () => void;
}) {
  const [active, setActive] = useState(initialTerms);
  const [custom, setCustom] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const bounds = greenhousePolicyBounds;
  const pool = [...new Map([...greenhouseDefaultRegularSearchTerms, ...initialTerms, ...custom].map(term => [term.trim().toLowerCase(), term])).values()];
  const full = active.length >= bounds.regularSearchTerms.max;
  function add() {
    const term = input.trim();
    if (!validGreenhouseSearchTerm(term)) { setError(`Enter a search term up to ${bounds.searchTerm} characters, without line breaks or control characters.`); return; }
    if (pool.some(value => value.trim().toLowerCase() === term.toLowerCase())) { setError("That term is already in the pool."); return; }
    setCustom([...custom, term]); setInput(""); setError("");
  }
  function move(term: string, to: TransferSide) {
    if (to === "right") {
      if (full || active.includes(term)) return;
      setActive([...active, term]);
    } else setActive(active.filter(value => value !== term));
    setError("");
  }
  function apply() {
    if (!active.length) { setError("Choose at least one regular search term."); return; }
    onApply(active);
  }
  return <GuidancePopup title="Regular search terms" onClose={onClose}>
    <div className="heading-help"><span>Search rotation</span><InfoTooltip label="About editing regular search terms">Move terms between the pool and Searching by dragging or using the arrows. The order in Searching is the rotation order; return a term and add it again to move it to the end. Only Searching is saved, not unused custom pool terms. Apply edits the draft, and Cancel leaves it unchanged.</InfoTooltip></div>
    <GuidanceTransfer
      left={{ title: "Pool", empty: "All pool terms are searching.", items: pool.filter(term => !active.includes(term)).map(label => ({ id: label, label, moveDisabled: full })) }}
      right={{ title: `Searching (${active.length}/${bounds.regularSearchTerms.max})`, empty: "No regular searches selected.", items: active.map(label => ({ id: label, label })) }}
      moveLabel={(item, to) => to === "right" ? `Search for ${item.label}` : `Return ${item.label} to pool`} onMove={move} />
    {full && <p className="small" role="status">Search limit reached. Return a term to the pool to choose another.</p>}
    <form className="guidance-popup-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <label htmlFor="guidance-regular-term">Custom regular search term</label>
      <input id="guidance-regular-term" value={input} maxLength={bounds.searchTerm} onChange={event => setInput(event.target.value)} />
      <button className="button secondary" disabled={!input.trim()}>Add to pool</button>
    </form>
    {error && <p className="intake-error" role="alert">{error}</p>}
    <div className="guidance-popup-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={apply}>Apply</button></div>
  </GuidancePopup>;
}
