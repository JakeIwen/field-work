import { HttpError, sha256 } from "./storage.js";

type Cursor = { at: string; id: string; kind: string; scope: string };
/** `fallback` (the saved page-size setting) applies when the request names no limit. */
export function pageLimit(
  value: number | undefined,
  maximum: number,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new HttpError(400, `Limit must be between 1 and ${maximum}`);
  return value;
}
export function pageCursor(
  row: { at?: string; id: string; kind?: string },
  scope: string,
) {
  return Buffer.from(
    JSON.stringify({
      at: row.at ?? "",
      id: row.id,
      kind: row.kind ?? "",
      scope: sha256(scope),
    }),
  ).toString("base64url");
}
export function readPageCursor(
  value: string | undefined,
  scope: string,
): Cursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 4096 || !/^[\w-]+$/.test(value)) throw Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    if (!parsed || typeof parsed !== "object") throw Error();
    const cursor = parsed as Partial<Cursor>;
    if (
      typeof cursor.at !== "string" ||
      typeof cursor.id !== "string" ||
      typeof cursor.kind !== "string" ||
      cursor.scope !== sha256(scope)
    )
      throw Error();
    return cursor as Cursor;
  } catch {
    throw new HttpError(400, "Invalid page cursor for these filters");
  }
}
