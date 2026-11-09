import { sha256 } from "../storage.js";
import type { Company } from "../../shared/types.js";

export const COMPANY_PATH = "company_careers/companies.md";
export const isoDate = (text: string) => {
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (
    !date ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    return null;
  return date;
};
export const safeUrl = (text: string) =>
  text.match(/https?:\/\/[^\s)<>]+/)?.[0] ?? "";

export function fieldsIn(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let current = "";
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*[-*]\s+\*\*([^*]+?):\*\*\s*(.*)$/);
    if (match) {
      current = match[1];
      fields[current] = match[2].trim();
    } else if (current && /^\s+\S/.test(line))
      fields[current] += ` ${line.trim()}`;
  }
  return fields;
}

export function parseCompanies(markdown: string): Company[] {
  const sections = markdown.split(/^##\s+/m).slice(1);
  const seen = new Set<string>();
  const result: Company[] = [];
  for (const section of sections) {
    const id = section.match(/<!--\s*company_id:\s*([a-z0-9-]+)\s*-->/)?.[1];
    if (!id) throw new Error("Company section has no stable company_id");
    if (seen.has(id)) throw new Error(`Duplicate company identity: ${id}`);
    seen.add(id);
    const fields = fieldsIn(section);
    const name = section
      .split("\n")[0]
      .replace(/^\d+\.\s*/, "")
      .trim();
    delete fields["Monitoring priority"];
    if (!name || !fields["Careers URL"])
      throw new Error(`Incomplete company: ${id}`);
    result.push({
      id,
      name,
      fields,
      sourcePath: COMPANY_PATH,
      sourceDate: isoDate(fields["Last researched"] ?? ""),
      text: section.trim(),
      hash: sha256(section.trim()),
    });
  }
  if (
    !result.length &&
    !/no (?:monitored )?companies|empty watchlist/i.test(markdown)
  )
    throw new Error("No valid companies found");
  return result;
}

/** Keep source salary language intact; numeric bands are only an aid for filtering, never a replacement. */
export function salaryBands(text: string): {
  text: string;
  min: number;
  max: number;
  currency: string;
  basis: string;
}[] {
  const result: ReturnType<typeof salaryBands> = [];
  const pattern =
    /\$\s*([\d,]+(?:\.\d+)?)\s*([kK]?)(?:\s*[–—-]\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([kK]?))?/g;
  const boundaries = [...text.matchAll(/;\s*|[.!?](?:\s+|$)/g)];
  for (const m of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, m.index! - 45), m.index);
    const after = text.slice(
      m.index! + m[0].length,
      text.indexOf(";", m.index!) < 0 ? undefined : text.indexOf(";", m.index!),
    );
    const start = boundaries
      .filter((b) => b.index! + b[0].length <= m.index!)
      .at(-1);
    const end = boundaries.find((b) => b.index! >= m.index! + m[0].length);
    const localBefore = text.slice(
      start ? start.index! + start[0].length : 0,
      m.index,
    );
    const localAfter = text.slice(m.index! + m[0].length, end?.index);
    // Match pay units adjacent to this amount, not unrelated weekly hours or monthly benefits.
    if (
      /^\s*(?:USD|CAD|AUD|EUR|GBP)?\s*(?:(?:\/|per\s+)(?:hours?|hrs?|weeks?|months?|days?)\b|(?:hourly|weekly|monthly|daily)\b)/i.test(
        localAfter,
      ) ||
      /\b(?:hourly|weekly|monthly|daily)\s+(?:(?:gross|base|pay|salary|rate|wage|compensation)\s*)?(?:of|is|:)?\s*$/i.test(
        localBefore,
      )
    )
      continue;
    // Expectations and historical estimates must not become a published salary filter value.
    const historical = [
      ...localBefore.matchAll(
        /\b(?:historical|earlier|previous(?:ly)?|formerly|expired|old(?:er)?|reported|estimat(?:e|ed)|target|desired|at least|used to|no longer)\b/gi,
      ),
    ].at(-1);
    const current = [
      ...localBefore.matchAll(/\b(?:current(?:ly)?|now|today)\b/gi),
    ].at(-1);
    if (
      (historical && (!current || historical.index! > current.index!)) ||
      /\bconfirm\b[^$]*$/i.test(localBefore) ||
      /\b(?:not (?:a )?current (?:quote|range|band|salary)|historical|expired|estimate(?:d)?|previous posting|earlier posting)\b/i.test(
        localAfter,
      )
    )
      continue;
    const rawMin = Number(m[1].replace(/,/g, "")),
      rawMax = m[3] ? Number(m[3].replace(/,/g, "")) : rawMin;
    const min = rawMin * (m[2] || (m[4] && rawMin < 1000) ? 1000 : 1);
    const max = m[3]
      ? rawMax * (m[4] || (m[2] && rawMax < 1000) ? 1000 : 1)
      : min;
    if (min < 1000 || max < min) continue;
    const afterLabel = localAfter.match(
      /^\s*(base(?: salary)?|salary|annual pay|bonus|equity|stock(?: options)?|options|OTE|total compensation)\b/i,
    );
    const componentAfter =
      afterLabel &&
      !/^\s*(?:is |are )?separate\b/i.test(
        localAfter.slice(afterLabel[0].length),
      )
        ? afterLabel[1]
        : undefined;
    const beforeLabel = [
      ...localBefore.matchAll(
        /\b(base(?: salary)?|salary|annual pay|bonus|equity|stock(?: options)?|options|OTE|total compensation)\b/gi,
      ),
    ].at(-1);
    const componentBefore =
      beforeLabel &&
      !/\bseparate\b/i.test(
        localBefore.slice(beforeLabel.index! + beforeLabel[0].length),
      )
        ? beforeLabel[1]
        : undefined;
    const component = componentAfter ?? componentBefore;
    const basis = component
      ? /OTE|total compensation/i.test(component)
        ? "total compensation"
        : /bonus/i.test(component)
          ? "bonus"
          : /equity|stock|options/i.test(component)
            ? "equity"
            : "published base"
      : "published base";
    result.push({
      text: `${before}${m[0]}${after}`.trim(),
      min,
      max,
      currency: /\bCAD\b/i.test(`${before}${after}`)
        ? "CAD"
        : /\bAUD\b/i.test(`${before}${after}`)
          ? "AUD"
          : "USD",
      basis,
    });
  }
  return result;
}
