export const usStates: Record<string, string> = Object.fromEntries(
  "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming"
    .split("|")
    .map((s) => s.split(":")),
);

/** The state codes in a list such as "Alaska, California, DC, … or West
 * Virginia", or null unless every item is a US state or DC. "Washington, DC"
 * is ambiguous between one place and two, so it is not read. */
export function statesNamedInList(list: string): string[] | null {
  const text = list
    .toLowerCase()
    .replace(/[?.]+$/, "")
    .trim();
  if (/\bwashington,? d\.?c\b/.test(text)) return null;
  const items = text
    .replace(/\bd\.c\./g, "dc")
    .split(/\s*,\s*(?:or |and )?|\s+(?:or|and)\s+/)
    .map((item) => item.trim());
  if (items.length < 2) return null;
  const codes = items.map(
    (item) =>
      Object.keys(usStates).find(
        (code) =>
          code.toLowerCase() === item || usStates[code].toLowerCase() === item,
      ) ?? null,
  );
  return codes.every((code) => code !== null) ? (codes as string[]) : null;
}
