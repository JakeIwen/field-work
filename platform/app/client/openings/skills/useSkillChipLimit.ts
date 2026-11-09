import { useLayoutEffect, useRef, useState } from "react";
import { fitSkillChips } from "./fit-skill-chips";

export function useSkillChipLimit(skillKey: string, total: number) {
  const container = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState({ key: skillKey, visible: total, overflowOnNewRow: false });
  useLayoutEffect(() => {
    const element = container.current, strip = measure.current;
    if (!element || !strip) return;
    let width = element.getBoundingClientRect().width;
    let widths: number[] = [], overflowWidth = 0, gap = 0, disposed = false;
    const fit = () => {
      const layout = fitSkillChips(widths, width, gap, overflowWidth);
      setLimit(previous => previous.key === skillKey && previous.visible === layout.visible && previous.overflowOnNewRow === layout.overflowOnNewRow ? previous : { key: skillKey, ...layout });
    };
    const readWidths = () => {
      if (disposed) return;
      // One read pass only when text or fonts change; resize reuses these widths.
      const sizes = [...strip.children].map(child => child.getBoundingClientRect().width);
      overflowWidth = sizes.pop() ?? 0;
      widths = sizes;
      gap = parseFloat(window.getComputedStyle(element).columnGap) || 0;
      fit();
    };
    readWidths();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next === undefined || next === width) return;
      width = next;
      // Hidden columns have zero-sized measuring chips; measure after they reappear.
      if (width > 0 && widths.some(size => !size)) readWidths();
      else fit();
    });
    observer?.observe(element);
    const fonts = document.fonts;
    fonts?.addEventListener("loadingdone", readWidths);
    return () => { disposed = true; observer?.disconnect(); fonts?.removeEventListener("loadingdone", readWidths); };
  }, [skillKey]);
  return { container, measure, visible: limit.key === skillKey ? limit.visible : total, overflowOnNewRow: limit.key === skillKey && limit.overflowOnNewRow };
}
