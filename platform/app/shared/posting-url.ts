// Shared posting URL identity. Used by careers scans, URL imports, opening
// overlays and validation so every path strips the same tracking parameters.
// Requisition parameters such as gh_jid and ashby_jid are identities and kept.
const trackingParameter =
  /^(?:utm_.+|gh_src|source|ref|referrer|trackingid|lever-source|lever-origin)$/i;

export function canonicalPostingUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return String(url ?? "").trim();
  }
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (trackingParameter.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

export type PostingAts = "greenhouse" | "lever" | "ashby" | "workday" | "other";
export type PostingIdentity = {
  ats: PostingAts;
  board: string | null;
  jobId: string | null;
};

const segments = (u: URL) =>
  u.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

export function postingIdentity(url: string): PostingIdentity {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return { ats: "other", board: null, jobId: null };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = segments(u);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    // boards.greenhouse.io/<board>/jobs/<id>, job-boards(.eu).greenhouse.io/<board>/jobs/<id>,
    // boards.greenhouse.io/embed/job_app?for=<board>&token=<id>
    const jobs = parts.indexOf("jobs");
    if (jobs > 0 && /^\d+$/.test(parts[jobs + 1] ?? ""))
      return {
        ats: "greenhouse",
        board: parts[jobs - 1].toLowerCase(),
        jobId: parts[jobs + 1],
      };
    const token = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
    if (token && /^\d+$/.test(token))
      return {
        ats: "greenhouse",
        board:
          (u.searchParams.get("for") ?? parts[0] ?? "").toLowerCase() || null,
        jobId: token,
      };
    return {
      ats: "greenhouse",
      board: parts[0]?.toLowerCase() ?? null,
      jobId: null,
    };
  }
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid && /^\d+$/.test(ghJid))
    return { ats: "greenhouse", board: null, jobId: ghJid };
  if (/(^|\.)lever\.co$/.test(host) && /^jobs\./.test(host)) {
    const id = parts[1];
    return {
      ats: "lever",
      board: parts[0]?.toLowerCase() ?? null,
      jobId: id && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null,
    };
  }
  if (host === "jobs.ashbyhq.com") {
    const id = parts[1];
    return {
      ats: "ashby",
      board: parts[0]?.toLowerCase() ?? null,
      jobId: id && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null,
    };
  }
  const ashbyJid = u.searchParams.get("ashby_jid");
  if (ashbyJid && /^[0-9a-f-]{36}$/i.test(ashbyJid))
    return { ats: "ashby", board: null, jobId: ashbyJid.toLowerCase() };
  if (/\.myworkdayjobs\.com$/.test(host)) {
    // <tenant>.wd5.myworkdayjobs.com/[<locale>/]<site>/job/<location>/<slug>_<REQ-ID>
    const job = parts.indexOf("job");
    const site = job > 0 ? parts[job - 1] : null;
    const tail = job >= 0 ? (parts.at(-1) ?? "") : "";
    const underscore = tail.lastIndexOf("_");
    const jobId =
      job >= 0 && underscore > 0 && underscore < tail.length - 1
        ? tail.slice(underscore + 1)
        : null;
    const tenant = host.split(".")[0];
    return {
      ats: "workday",
      board: site ? `${tenant}/${site}`.toLowerCase() : tenant,
      jobId: jobId ? jobId.toUpperCase() : null,
    };
  }
  return { ats: "other", board: null, jobId: null };
}

// Two URLs refer to the same vacancy by ATS requisition. Workday requisition IDs
// are only unique within a tenant/site; the other ATS IDs are globally unique.
export function samePostingIdentity(a: PostingIdentity, b: PostingIdentity) {
  if (a.ats === "other" || a.ats !== b.ats || !a.jobId || a.jobId !== b.jobId)
    return false;
  return a.ats !== "workday" || (!!a.board && a.board === b.board);
}

export function normalizeCompanyName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(
      /\b(?:the|incorporated|inc|llc|ltd|limited|corporation|corp|plc|gmbh)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(title: string): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Retired integrations must not be rediscovered through generic scan fallbacks. */
export function retiredJobBoard(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(ashbyhq\.com|lever\.co)$/.test(host);
  } catch {
    return false;
  }
}
