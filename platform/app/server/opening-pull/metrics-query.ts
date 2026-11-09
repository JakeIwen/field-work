import { HttpError } from "../storage.js";
import {
  pullMetricSections,
  pullMetricGroupings,
  pullMetricSorts,
  type PullMetricsQuery,
} from "../../shared/greenhouse-pull-metrics.js";

export function parsePullMetricsQuery(
  query: Record<string, unknown>,
): PullMetricsQuery {
  const text = (key: string, fallback = "", max = 500) => {
    const value = query[key] ?? fallback;
    if (typeof value !== "string" || value.length > max)
      throw new HttpError(400, `Invalid metrics ${key}`);
    return value;
  };
  const choice = <T extends string>(
    key: string,
    options: Record<T, string>,
    fallback: T,
  ): T => {
    const value = text(key, fallback);
    if (!Object.hasOwn(options, value))
      throw new HttpError(400, `Invalid metrics ${key}`);
    return value as T;
  };
  const offsetText = text("offset", "0");
  if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText)))
    throw new HttpError(400, "Invalid metrics offset");
  const include = text("includeDuplicates", "false");
  if (include !== "true" && include !== "false")
    throw new HttpError(400, "Invalid metrics includeDuplicates");
  return {
    section: choice("section", pullMetricSections, "scan"),
    groupBy: choice("groupBy", pullMetricGroupings, "metric"),
    sort: choice("sort", pullMetricSorts, "count"),
    metric: text("metric"),
    search: text("search").trim(),
    includeDuplicates: include === "true",
    offset: Number(offsetText),
    group: text("group") || undefined,
    posting: text("posting") || undefined,
  };
}
