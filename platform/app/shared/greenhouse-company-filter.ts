export type GreenhouseCompanyFilterSettings = {
  greenhouseExcludedCompanies?: string[];
};

export const greenhouseCompanyFilterLimits = { count: 100, length: 120 };

// Unlike company deduplication, this exact filter never strips legal suffixes.
export function greenhouseCompanyKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function excludedGreenhouseCompany(
  excluded: string[],
  company: string,
  board: string,
) {
  const identities = [
    greenhouseCompanyKey(company),
    greenhouseCompanyKey(board),
  ].filter(Boolean);
  return excluded.some((value) =>
    identities.includes(greenhouseCompanyKey(value)),
  );
}
