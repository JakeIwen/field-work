import { useEffect, useState } from "react";

type Section = { id: string; label: string };

// Fieldwork routes by URL hash, so in-page anchors would change the page; the index scrolls with buttons.
const ACTIVE_OFFSET = 96;

function currentSection(sections: readonly Section[]) {
  let current = sections[0]?.id ?? "";
  for (const { id } of sections) {
    const top = document.getElementById(id)?.getBoundingClientRect().top;
    if (top !== undefined && top <= ACTIVE_OFFSET) current = id;
  }
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  return atEnd && sections.length ? sections[sections.length - 1].id : current;
}

export default function SettingsNav({ sections }: { sections: readonly Section[] }) {
  const [active, setActive] = useState(() => sections[0]?.id ?? "");
  useEffect(() => {
    let frame = 0;
    const update = () => { frame = 0; setActive(currentSection(sections)); };
    const schedule = () => {
      if (typeof requestAnimationFrame !== "function") return update();
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    return () => {
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sections]);
  const show = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.querySelector<HTMLButtonElement>('[data-settings-toggle][aria-expanded="false"]')?.click();
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    target.focus({ preventScroll: true });
  };
  return <nav className="settings-nav" aria-label="Settings sections">
    <ul>
      {sections.map(section => <li key={section.id}>
        <button type="button" className={`settings-nav-link${active === section.id ? " active" : ""}`}
          aria-current={active === section.id ? "location" : undefined} onClick={() => show(section.id)}>
          {section.label}
        </button>
      </li>)}
    </ul>
  </nav>;
}
