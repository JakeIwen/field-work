export const skillChipRowLimit = 7;

export type SkillChipLayout = { visible: number; overflowOnNewRow: boolean };

/** Longest prefix that fits, reserving the final chip for hidden-skill disclosure. */
export function fitSkillChips(widths: readonly number[], available: number, gap: number, overflowWidth: number, maxRows = skillChipRowLimit): SkillChipLayout {
  if (available <= 0 || maxRows < 1) return { visible: 0, overflowOnNewRow: false };
  let row = 1, used = 0;
  let result = { visible: 0, overflowOnNewRow: false };
  for (let i = 0; i < widths.length; i++) {
    const width = Math.min(widths[i], available);
    if (i > 0 && used + gap + width > available) { row++; used = width; }
    else used += (i > 0 ? gap : 0) + width;
    if (row > maxRows) break;
    if (i === widths.length - 1) return { visible: widths.length, overflowOnNewRow: false };
    const overflowRow = row + Number(used + gap + Math.min(overflowWidth, available) > available);
    if (overflowRow <= maxRows) result = { visible: i + 1, overflowOnNewRow: overflowRow < maxRows };
  }
  // A wide next chip may use all of row seven; keep the disclosure on that row
  // instead of leaving it on row six when the wide chip must be hidden.
  return result;
}
