const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.:]+$/, "");

export function isDiscoveryQuestion(label: string, company = "") {
  const q = normalize(
    label.replace(/\s*\((?:select|check) all that apply\)\s*[?.:]?$/i, ""),
  );
  const subject =
    /^(?:how|where) did you (?:first )?(?:hear about|learn about|learn of|find out about|find|discover) (.+)$/.exec(
      q,
    )?.[1];
  const names = company
    ? [
        normalize(company),
        normalize(company).replace(
          /,?\s+(?:inc|llc|ltd|corp|corporation)\.?$/,
          "",
        ),
      ]
    : [];
  return (
    Boolean(
      subject &&
      (/^(?:us|(?:this|the|our) (?:role|job|position|opportunity|opening)|this job opportunity)$/.test(
        subject,
      ) ||
        names.includes(subject)),
    ) ||
    [
      "source",
      "application source",
      "referral source",
      "where did you find us",
      "tell us how you heard about this role",
    ].includes(q)
  );
}

/** Use the user's declared discovery preference, never invent a referrer. */
export function discoveryAnswer(
  label: string,
  options: string[] | undefined,
  profile: any,
  service: string,
  company = "",
) {
  if (
    profile.discoverySource?.strategy !== "hosting-service-search" ||
    !isDiscoveryQuestion(label, company)
  )
    return null;
  if (options === undefined) return `Search on ${service}`;
  const ranks =
    service.toLowerCase() === "greenhouse.io"
      ? [
          [
            "greenhouse",
            "greenhouse.io",
            "mygreenhouse",
            "greenhouse job board",
            "greenhouse search",
            "search on greenhouse.io",
          ],
          [
            "job board",
            "online job board",
            "job search website",
            "job search site",
            "online job search",
          ],
          ["other job board", "other job boards"],
          ["online search", "internet search", "web search"],
          ["other", "other (please specify)"],
        ]
      : [
          [normalize(service)],
          ["job board", "online job board", "job search website"],
          ["online search", "internet search"],
          ["other", "other (please specify)"],
        ];
  for (const rank of ranks) {
    const matches = options.filter((option) =>
      rank.includes(normalize(option)),
    );
    if (matches.length) return matches.length === 1 ? matches[0] : null;
  }
  return null;
}
