import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Plus, X } from "lucide-react";
import type { Opening } from "../../../shared/types";
import { openingSkills, skillMatchesQuery } from "../../../shared/opening-skills";
import InfoTooltip from "../../ui/InfoTooltip";
import { emptySkillFilter, toggleSkill, type SkillFilter } from "./opening-skill-filter";
import "./opening-skills.css";

const skillFilterHelp = "Select Include, then choose skills. Any matches at least one included skill (OR); All requires every included skill (AND). Select Exclude to hide openings containing any excluded skill. A minus sign marks exclusions. Click a selected chip again to remove it, or Shift-click any skill to toggle its exclusion. Counts show openings matching your other filters. Names are standardized: JavaScript and java script appear as JS. Chips reflect named technologies in the saved requirements, including preferred skills and alternatives; they do not mean every skill is mandatory. Openings with no recognized skills remain visible unless you include a skill.";

function skillOptions(openings: Opening[], value: SkillFilter, query: string) {
  const counts = new Map<string, number>();
  for (const opening of openings) for (const skill of openingSkills(opening)) counts.set(skill, (counts.get(skill) || 0) + 1);
  for (const skill of [...value.include, ...value.exclude]) if (!counts.has(skill)) counts.set(skill, 0);
  return [...counts].filter(([skill]) => skillMatchesQuery(skill, query)).sort(([a], [b]) => a.localeCompare(b));
}

function SkillSelection({ value, onChange }: { value: SkillFilter; onChange: (value: SkillFilter) => void }) {
  return <div className="skill-selection" aria-label="Selected skill filters">
    {(["include", "exclude"] as const).map(mode => value[mode].length > 0 && <div className="skill-clause" key={mode}>
      <span className="small muted">{mode === "exclude" ? "Without" : value.match === "all" ? "All of" : "Any of"}</span>
      {value[mode].map(skill => <button key={skill} type="button" className={`skill-chip ${mode === "include" ? "skill-included" : "skill-excluded"}`}
        onClick={() => onChange(toggleSkill(value, skill, mode))} aria-label={`Remove ${mode === "exclude" ? "excluded" : "included"} ${skill}`} title={`Remove ${skill} filter`}>
        {mode === "include" ? <Plus size={12} /> : <Minus size={12} />}{skill}<X size={11} />
      </button>)}
    </div>)}
  </div>;
}

function useSkillPopover(open: boolean, setOpen: (value: boolean) => void) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popover.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = popover.current.getBoundingClientRect();
    const next = {
      top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 12)),
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12)),
    };
    setPosition(previous => previous.top === next.top && previous.left === next.left ? previous : next);
  });
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !(event.target as Element).closest?.("[role=tooltip]")) setOpen(false);
    };
    const resize = () => setOpen(false);
    const scroll = (event: Event) => {
      if (!root.current?.contains(event.target as Node) && !(event.target as Element).closest?.("[role=tooltip]")) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, setOpen]);
  return { root, trigger, search, popover, position };
}

export function OpeningSkillsFilter({ openings, value, onChange }: {
  openings: Opening[]; value: SkillFilter; onChange: (value: SkillFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const { root, trigger, search, popover, position } = useSkillPopover(open, setOpen);
  const id = useId();
  const selectedCount = value.include.length + value.exclude.length;
  const options = skillOptions(openings, value, query);
  return <div className="opening-skill-filter" ref={root}>
    <div className="skill-filter-controls">
      <button ref={trigger} type="button" className="button secondary small-button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}>Skills{selectedCount > 0 && <span className="skill-filter-count">{selectedCount}</span>}<ChevronDown size={14} /></button>
      {!open && <InfoTooltip label="How to filter by skills">{skillFilterHelp}</InfoTooltip>}
      {selectedCount > 0 && <button type="button" className="text-button" onClick={() => onChange(emptySkillFilter)}>Clear skills</button>}
    </div>
    {selectedCount > 0 && <SkillSelection value={value} onChange={onChange} />}
    {open && <div ref={popover} style={position} className="skill-popover" role="dialog" aria-label="Filter by skills" id={id} onKeyDown={event => {
      if (event.key !== "Escape" || document.querySelector("[role=tooltip]")) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }}>
      <div className="skill-popover-heading"><div className="heading-help"><strong>Skills</strong><InfoTooltip label="How to filter by skills">{skillFilterHelp}</InfoTooltip></div><button type="button" className="icon-button" aria-label="Close skills filter" title="Close skills filter" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} /></button></div>
      <input ref={search} type="search" aria-label="Find a skill" placeholder="Find a skill…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="skill-popover-toolbar">
        <div className="skill-segment" role="group" aria-label="Skill selection mode">
          <button type="button" aria-pressed={mode === "include"} onClick={() => setMode("include")}><Plus size={13} />Include</button>
          <button type="button" aria-pressed={mode === "exclude"} onClick={() => setMode("exclude")}><Minus size={13} />Exclude</button>
        </div>
        <label className="skill-match">Match<select aria-label="Match included skills" value={value.match} onChange={event => onChange({ ...value, match: event.target.value as SkillFilter["match"] })}>
          <option value="any">Any (OR)</option><option value="all">All (AND)</option>
        </select></label>
      </div>
      <div className="skill-options" aria-label="Available skills">
        {options.map(([skill, count]) => {
          const included = value.include.includes(skill), excluded = value.exclude.includes(skill);
          return <button type="button" key={skill} className={`skill-chip${included ? " skill-included" : excluded ? " skill-excluded" : ""}`}
            aria-pressed={included || excluded} aria-label={`${skill}${included ? ", included" : excluded ? ", excluded" : ""}, ${count} openings`}
            title={`${mode === "include" ? "Include" : "Exclude"} ${skill}; Shift-click to exclude`}
            onClick={event => onChange(toggleSkill(value, skill, event.shiftKey ? "exclude" : mode))}>
            {included ? <Plus size={12} /> : excluded ? <Minus size={12} /> : null}{skill}<span className="skill-option-count">{count}</span>
          </button>;
        })}
        {!options.length && <span className="muted small">No matching skills.</span>}
      </div>
    </div>}
  </div>;
}
