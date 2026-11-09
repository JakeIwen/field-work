import { load } from "cheerio";
import type { ApplicationCompensation } from "../../shared/application-form.js";
import { salaryBands } from "../importer.js";

export const isSalaryQuestion = (label: string) => {
  const q = label
    .trim()
    .replace(/[?*]+$/, "")
    .replace(/\s+/g, " ")
    .replace(
      /\s+(?:in (?:your |the )?(?:local currency|[A-Z]{3})|\([A-Z]{3}\))$/i,
      "",
    );
  return (
    /^(?:what (?:are|is) your |please (?:provide|state|select|indicate) your )?(?:(?:desired|expected|minimum|base|annual|yearly|hourly|weekly|monthly|target) )*(?:salary|base pay)(?: expectations?| requirements?)?(?: range)?$/i.test(
      q,
    ) ||
    /^(?:what (?:are|is) your |please (?:provide|state|select|indicate) your )?(?:(?:desired|expected|minimum|target) )?(?:hourly|weekly|monthly|annual|yearly) (?:pay|rate|compensation)(?: expectations?| requirements?)?(?: range)?$/i.test(
      q,
    )
  );
};

type Pay = {
  amount: number;
  currency: string;
  period: string;
  publishedText?: string;
};
type PublishedPayRange = {
  title?: unknown;
  blurb?: unknown;
  min_cents?: unknown;
  max_cents?: unknown;
  currency_type?: unknown;
};
export type SalaryPosting = {
  content?: unknown;
  pay_input_ranges?: PublishedPayRange[];
  compensation?: ApplicationCompensation | null;
};
type SalaryField = {
  label: string;
  inputType?: string;
  kind?: string;
  options?: string[];
};

type CandidateResult = {
  candidates: Pay[];
  published: boolean;
  publishedText?: string;
  reviewReason?: string;
};

function withPublishedText(reason: string, publishedText?: string) {
  return publishedText ? `${reason} Published pay: ${publishedText}` : reason;
}

function periodOf(value: string) {
  if (/\bhourly\b|(?:per\s+|\/)hours?\b/i.test(value)) return "hour";
  if (/\bmonthly\b|(?:per\s+|\/)months?\b/i.test(value)) return "month";
  if (/\bweekly\b|(?:per\s+|\/)weeks?\b/i.test(value)) return "week";
  if (/\b(?:annual|annually)\b|(?:per\s+|\/)years?\b/i.test(value))
    return "year";
  return "";
}

function requestedPeriod(label: string) {
  if (/\bhourly\b|(?:per\s+|\/)hours?\b/i.test(label)) return "hour";
  if (/\bweekly\b|(?:per\s+|\/)weeks?\b/i.test(label)) return "week";
  if (/\bmonthly\b|(?:per\s+|\/)months?\b/i.test(label)) return "month";
  if (/\b(?:annual|annually|yearly)\b|(?:per\s+|\/)years?\b/i.test(label))
    return "year";
  return "";
}

function salaryPreference(profile: Record<string, unknown>) {
  const value = profile.salaryExpectation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const strategy = "strategy" in value ? value.strategy : undefined;
  const fallbackAnnualUsd =
    "fallbackAnnualUsd" in value ? value.fallbackAnnualUsd : undefined;
  const rangeTopAnnualUsd =
    "rangeTopAnnualUsd" in value ? value.rangeTopAnnualUsd : undefined;
  return {
    strategy,
    fallbackAnnualUsd:
      typeof fallbackAnnualUsd === "number" ? fallbackAnnualUsd : undefined,
    rangeTopAnnualUsd:
      typeof rangeTopAnnualUsd === "number" &&
      Number.isFinite(rangeTopAnnualUsd) &&
      rangeTopAnnualUsd > 0
        ? rangeTopAnnualUsd
        : undefined,
  };
}

function savedCountry(profile: Record<string, unknown>) {
  const location = profile.location;
  if (!location || typeof location !== "object" || Array.isArray(location))
    return;
  return "country" in location && typeof location.country === "string"
    ? location.country
    : undefined;
}

function normalizedPayCandidates(
  compensation: ApplicationCompensation | null,
): CandidateResult {
  if (!compensation) return { candidates: [], published: false };
  const candidates: Pay[] = [];
  for (const range of compensation.ranges) {
    if (
      !compensation.interpretable ||
      typeof range.min !== "number" ||
      !Number.isFinite(range.min) ||
      range.min <= 0 ||
      typeof range.max !== "number" ||
      !Number.isFinite(range.max) ||
      range.max < range.min ||
      typeof range.currency !== "string" ||
      !/^[A-Z]{3}$/.test(range.currency) ||
      range.basis !== "base" ||
      range.period === "unknown"
    )
      return {
        candidates: [],
        published: true,
        publishedText: compensation.publishedText,
        reviewReason: withPublishedText(
          "Published pay has a compensation basis that could not be interpreted reliably; review the range without converting it.",
          compensation.publishedText,
        ),
      };
    candidates.push({
      amount: range.min,
      currency: range.currency,
      period: range.period,
      publishedText: range.publishedText,
    });
  }
  return candidates.length
    ? {
        candidates,
        published: true,
        publishedText: compensation.publishedText,
      }
    : {
        candidates,
        published: true,
        publishedText: compensation.publishedText,
        reviewReason: withPublishedText(
          "Published pay could not be interpreted reliably; review the range without converting it.",
          compensation.publishedText,
        ),
      };
}

function greenhousePayCandidates(ranges: PublishedPayRange[]): Pay[] {
  const candidates: Pay[] = [];
  for (const range of ranges) {
    const words = load(`${range.title ?? ""} ${range.blurb ?? ""}`).text();
    if (
      /\b(bonus|equity|stock|ote|total compensation)\b/i.test(
        String(range.title ?? ""),
      )
    )
      continue;
    const minCents = range.min_cents;
    const maxCents = range.max_cents;
    const currency = range.currency_type;
    if (
      typeof minCents === "number" &&
      Number.isFinite(minCents) &&
      minCents > 0 &&
      typeof maxCents === "number" &&
      Number.isFinite(maxCents) &&
      maxCents >= minCents &&
      typeof currency === "string" &&
      /^[A-Z]{3}$/.test(currency)
    )
      candidates.push({
        amount: minCents / 100,
        currency,
        period: periodOf(words),
      });
  }
  return candidates;
}

function htmlPayCandidates(content: string): CandidateResult {
  for (let i = 0; i < 2 && /&lt;/i.test(content); i++)
    content = load(content).text();
  const $ = load(content);
  const candidates: Pay[] = [];
  let published = false;
  $("p, li, .pay-range").each((_i, node) => {
    const element = $(node);
    const words = element.text();
    if (
      !(
        element.hasClass("pay-range") ||
        /\b(base (?:pay|salary)|salary|pay range)\b/i.test(words)
      ) ||
      !/[$€£]\s*\d/.test(words)
    )
      return;
    published = true;
    const period = periodOf(words);
    if (["hour", "week", "month"].includes(period)) {
      const match =
        /\$\s*([\d,]+(?:\.\d+)?)\s*(?:[–—-]\s*\$?\s*([\d,]+(?:\.\d+)?))?/.exec(
          words,
        );
      if (match)
        candidates.push({
          amount: Number(match[1].replace(/,/g, "")),
          currency: /\bCAD\b/.test(words)
            ? "CAD"
            : /\bAUD\b/.test(words)
              ? "AUD"
              : "USD",
          period,
        });
      return;
    }
    const bands = salaryBands(words).filter(
      (band) => band.basis === "published base",
    );
    const ranged = bands.filter((band) => band.max > band.min);
    // Multiple standalone amounts can include a stipend; do not mistake
    // an ancillary benefit for the salary floor.
    for (const band of ranged.length ? ranged : bands.length === 1 ? bands : [])
      candidates.push({
        amount: band.min,
        currency: band.currency,
        period,
      });
  });
  return { candidates, published };
}

function payCandidates(api: SalaryPosting): CandidateResult {
  if (api.compensation !== undefined)
    return normalizedPayCandidates(api.compensation);
  const ranges = Array.isArray(api.pay_input_ranges)
    ? api.pay_input_ranges
    : [];
  const candidates = greenhousePayCandidates(ranges);
  if (candidates.length) return { candidates, published: true };
  const html = htmlPayCandidates(String(api.content ?? ""));
  return {
    candidates: html.candidates,
    published: ranges.length > 0 || html.published,
  };
}

function payPeriodLabel(period: string) {
  return period === "hour"
    ? "hourly"
    : period === "week"
      ? "weekly"
      : period === "month"
        ? "monthly"
        : period === "year"
          ? "annual"
          : "an unspecified period";
}

function salaryOption(
  field: SalaryField,
  lowest: Pay,
  source: "published" | "fallback",
) {
  const matches = (field.options ?? []).filter((option) => {
    const period = periodOf(option);
    if (
      (["hour", "week", "month"].includes(lowest.period) &&
        period !== lowest.period) ||
      (period && lowest.period && period !== lowest.period)
    )
      return false;
    const normalized = option
      .trim()
      .replace(
        /\s*(?:per\s+(?:year|month|week|hour)|annually|annual|yearly|monthly|weekly|hourly)\s*$/i,
        "",
      );
    const match =
      /^(?:([A-Z]{3})\s*)?([$€£])?\s*([\d,]+(?:\.\d+)?)(k)?(?:\s*[–—-]\s*(?:[A-Z]{3}\s*)?[$€£]?\s*([\d,]+(?:\.\d+)?)(k)?)?$/i.exec(
        normalized,
      );
    if (!match) return false;
    const currency =
      match[1]?.toUpperCase() ||
      (match[2] === "€"
        ? "EUR"
        : match[2] === "£"
          ? "GBP"
          : match[2] === "$" && lowest.currency === "USD"
            ? "USD"
            : null);
    if (currency !== lowest.currency) return false;
    const min = Number(match[3].replace(/,/g, "")) * (match[4] ? 1000 : 1);
    const max = match[5]
      ? Number(match[5].replace(/,/g, "")) * (match[6] ? 1000 : 1)
      : min;
    return lowest.amount >= min && lowest.amount <= max;
  });
  return matches.length === 1
    ? {
        value: matches[0],
        source,
        amount: lowest.amount,
        currency: lowest.currency,
        period: lowest.period,
      }
    : {
        reviewReason: withPublishedText(
          "No unique salary option contains your saved expectation in the matching currency and pay period.",
          lowest.publishedText,
        ),
      };
}

function salaryUnitReview(
  field: SalaryField,
  profile: Record<string, unknown>,
  lowest: Pay,
): string | undefined {
  if (
    /local currency/i.test(field.label) &&
    savedCountry(profile) === "US" &&
    lowest.currency !== "USD"
  )
    return withPublishedText(
      "The published currency differs from your saved local currency; no conversion was made.",
      lowest.publishedText,
    );
  const requested = requestedPeriod(field.label);
  if (requested && lowest.period && requested !== lowest.period)
    return withPublishedText(
      `Published pay is ${payPeriodLabel(lowest.period)}, but this question requests ${payPeriodLabel(requested)} pay. Review the requested units; no pay-period conversion was made.`,
      lowest.publishedText,
    );
  if (
    !requested &&
    field.inputType === "number" &&
    ["hour", "week", "month"].includes(lowest.period)
  )
    return withPublishedText(
      "Published pay is not annual. Review the requested units; no annual conversion was made.",
      lowest.publishedText,
    );
  return undefined;
}

/** Use the current posting's pay, never convert hourly pay to an annual figure. */
export function salaryExpectation(
  api: SalaryPosting,
  profile: Record<string, unknown>,
  field: SalaryField,
) {
  const preference = salaryPreference(profile);
  if (preference?.strategy !== "lowest-posted") return null;
  const resolved = payCandidates(api);
  if (resolved.reviewReason) return { reviewReason: resolved.reviewReason };
  let candidates = resolved.candidates;
  let source: "published" | "fallback" = "published";
  if (!candidates.length) {
    if (resolved.published)
      return {
        reviewReason: withPublishedText(
          "Published pay could not be interpreted reliably; choose the expectation after reviewing the range.",
          resolved.publishedText,
        ),
      };
    const fallback = preference.fallbackAnnualUsd;
    if (fallback === undefined || !Number.isFinite(fallback) || fallback <= 0)
      return null;
    candidates = [{ amount: fallback, currency: "USD", period: "year" }];
    source = "fallback";
  }
  const currencies = new Set(candidates.map((candidate) => candidate.currency));
  const periods = new Set(
    candidates.map((candidate) => candidate.period).filter(Boolean),
  );
  if (currencies.size !== 1 || periods.size > 1)
    return {
      reviewReason: withPublishedText(
        "Published pay uses different currencies or periods; review before choosing a minimum.",
        resolved.publishedText,
      ),
    };
  const lowest = candidates.reduce((a, b) => (a.amount <= b.amount ? a : b));
  const unitReview = salaryUnitReview(field, profile, lowest);
  if (unitReview) return { reviewReason: unitReview };
  if (field.kind === "select") return salaryOption(field, lowest, source);
  const amount = lowest.amount.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  return {
    value:
      field.inputType === "number"
        ? String(lowest.amount)
        : `${lowest.currency === "USD" ? "$" : lowest.currency + " "}${amount}${lowest.period && lowest.period !== "year" ? " per " + lowest.period : ""}`,
    source,
    amount: lowest.amount,
    currency: lowest.currency,
    period: lowest.period,
  };
}

// "What is the end of your desired annual base salary range?" asks for the top
// of a range; the user's saved upper end (2026-10-20) answers it in annual USD.
export const isSalaryRangeEndQuestion = (label: string) =>
  /^(?:(?:what is|please (?:provide|enter|state|share)) )?(?:the )?(?:(?:upper|high|top) end|end|top|upper (?:limit|bound)|maximum|max|highest) (?:of )?(?:your )?(?:(?:desired|expected|target|preferred|annual|yearly|base) )*(?:salary|pay|compensation)(?: (?:range|expectations?|requirements?))?$/.test(
    label
      .replace(/\([^)]*\)/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  );

export function salaryRangeEnd(
  api: SalaryPosting,
  profile: Record<string, unknown>,
  field: SalaryField & { description?: string },
) {
  const top = salaryPreference(profile)?.rangeTopAnnualUsd;
  if (
    top === undefined ||
    field.kind === "select" ||
    savedCountry(profile) !== "US" ||
    !["", "year"].includes(requestedPeriod(field.label))
  )
    return null;
  const resolved = payCandidates(api);
  if (resolved.reviewReason) return { reviewReason: resolved.reviewReason };
  const published = resolved.candidates;
  if (published.some((pay) => pay.currency !== "USD"))
    return {
      reviewReason:
        "Published pay is not in USD; your saved upper end is annual USD.",
    };
  const annual = published.filter((pay) => pay.period === "year");
  if (annual.length && Math.min(...annual.map((pay) => pay.amount)) >= top)
    return {
      reviewReason: `Published annual pay starts at or above your saved upper end of $${top.toLocaleString("en-US")}.`,
    };
  const noCommas = /\b(?:no|without) commas\b/i.test(
    `${field.label} ${field.description ?? ""}`,
  );
  return {
    value:
      field.inputType === "number"
        ? String(top)
        : noCommas
          ? `$${top}`
          : `$${top.toLocaleString("en-US")}`,
  };
}
