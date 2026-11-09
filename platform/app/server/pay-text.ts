/** Pay lines quoted from posting text: detection only, never amount parsing. */
export function salaryLines(description: string) {
  return description
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        /[$€£]|\b(?:USD|CAD|EUR|GBP)\b/.test(s) &&
        /salary|pay|compensation|base|range|annua|zone|\$\s*[1-9][\d,.]*\s*(?:k|,000)|\$\d{3},/i.test(
          s,
        ),
    )
    .join(" ")
    .slice(0, 6000);
}
