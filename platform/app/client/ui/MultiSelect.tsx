import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./multi-select.css";

function useMultiSelectPopover(open: boolean, setOpen: (open: boolean) => void) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 180 });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = popup.current.getBoundingClientRect();
    const next = {
      top: Math.max(12, anchor.bottom + 4 + bounds.height <= window.innerHeight - 12
        ? anchor.bottom + 4 : anchor.top - bounds.height - 4),
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12)),
      width: Math.min(Math.max(anchor.width, 180), window.innerWidth - 24),
    };
    setPosition(previous => previous.top === next.top && previous.left === next.left && previous.width === next.width ? previous : next);
  });
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, setOpen]);
  return { root, trigger, popup, position };
}

export function MultiSelect({ label, value, onChange, options, emptyLabel }: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  options: readonly (string | readonly [string, string])[];
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const { root, trigger, popup, position } = useMultiSelectPopover(open, setOpen);
  const id = useId();
  const choices = options.map(option => typeof option === "string" ? [option, option] : option);
  const selected = choices.filter(([key]) => value.includes(key));
  const summary = selected.length === 0 ? emptyLabel
    : selected.length <= 2 ? selected.map(([, text]) => text).join(", ") : `${selected.length} selected`;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="select-field multi-select" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={event => {
      if (open && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
      }
    }}>
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="button secondary multi-select-trigger"
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-summary`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
      }}>
      <span id={`${id}-summary`} title={summary}>{summary}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div ref={popup} id={id} role="dialog" aria-labelledby={`${id}-label`}
      className="multi-select-popup" style={position}>
      {choices.map(([key, text]) => <label className="multi-select-option" key={key}>
        <input type="checkbox" checked={value.includes(key)} onChange={event =>
          onChange(event.target.checked ? [...value, key] : value.filter(item => item !== key))} />
        <span>{text}</span>
      </label>)}
      <button type="button" className="text-button" disabled={!value.length} onClick={() => onChange([])}>Clear selection</button>
    </div>}
  </div>;
}
