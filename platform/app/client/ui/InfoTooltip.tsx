import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import "./info-tooltip.css";

export default function InfoTooltip({ label, children, icon, triggerLabel, className = "" }: { label: string; children: ReactNode; icon?: ReactNode; triggerLabel?: string; className?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (document.activeElement !== button.current) setOpen(false);
    }, 120);
  };
  useLayoutEffect(() => {
    if (!open || !button.current || !tip.current) return;
    const anchor = button.current.getBoundingClientRect();
    const bounds = tip.current.getBoundingClientRect();
    const below = anchor.bottom + 6;
    setPosition({
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12)),
      top: below + bounds.height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - bounds.height - 6),
    });
  }, [open, children]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const outside = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node) && !tip.current?.contains(event.target as Node)) dismiss();
    };
    const scroll = (event: Event) => {
      if (!tip.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    <button ref={button} type="button" className={`info-tooltip-button${className ? ' ' + className : ''}`} aria-label={label}
      aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={leave}
      onFocus={show} onBlur={() => setOpen(false)}
      onClick={event => { event.preventDefault(); event.stopPropagation(); show(); }}>
      {triggerLabel ?? icon ?? <Info size={15} aria-hidden="true" />}
    </button>
    {open && createPortal(<div ref={tip} id={id} role="tooltip" className="info-tooltip"
      style={position} onMouseEnter={show} onMouseLeave={leave}>{children}</div>, document.body)}
  </>;
}
