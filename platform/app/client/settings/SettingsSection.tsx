import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SettingsSectionId } from "./settings-sections";

/** Shared shell for one Settings section: a focusable scroll target with the panel heading layout. */
export default function SettingsSection({ id, title, help, description, icon, className, children, collapsible = false, defaultOpen = false }: {
  id: SettingsSectionId;
  title: ReactNode;
  help?: ReactNode;
  description?: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const heading = collapsible ? <button type="button" className="text-button settings-section-toggle"
    data-settings-toggle aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>
    {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}{title}
  </button> : title;
  return <section id={id} className={`panel settings-section${className ? ` ${className}` : ""}`} aria-labelledby={`${id}-heading`} tabIndex={-1}>
    <div className="section-heading">
      <div>
        {help ? <div className="heading-help"><h2 id={`${id}-heading`}>{heading}</h2>{help}</div> : <h2 id={`${id}-heading`}>{heading}</h2>}
        {description && <p>{description}</p>}
      </div>
      {icon}
    </div>
    {collapsible ? <div id={`${id}-body`} hidden={!open}>{open && children}</div> : children}
  </section>;
}
