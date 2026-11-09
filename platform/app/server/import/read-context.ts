import { tunableValue, type TunableSettings } from "../../shared/tunables.js";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { RescanProgress } from "../../shared/rescan-progress.js";
import type { HealthIssue } from "../../shared/types.js";
import { sha256 } from "../storage.js";

export type ReadContext = {
  root: string;
  settings?: () => TunableSettings;
  sourceHashes: Record<string, string>;
  health: HealthIssue[];
  onProgress?: (progress: RescanProgress) => void;
};

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function issue(
  ctx: ReadContext,
  severity: HealthIssue["severity"],
  category: string,
  message: string,
  paths: string[] = [],
  details?: unknown,
) {
  ctx.health.push({
    id: `${category}:${sha256(`${message}:${paths.join("|")}`).slice(0, 18)}`,
    severity,
    category,
    message,
    paths,
    ...(details ? { details } : {}),
  });
}

export async function readSafe(
  ctx: ReadContext,
  relative: string,
): Promise<Buffer> {
  const absolute = path.resolve(ctx.root, relative);
  const resolved = await realpath(absolute);
  if (resolved !== ctx.root && !resolved.startsWith(ctx.root + path.sep))
    throw new Error(`Path escapes repository: ${relative}`);
  const info = await stat(resolved);
  if (
    !info.isFile() ||
    info.size >
      tunableValue(ctx.settings?.() ?? {}, "records.sourceFileLimitMiB") *
        1024 *
        1024
  )
    throw new Error(`Not a bounded regular file: ${relative}`);
  const value = await readFile(resolved);
  ctx.sourceHashes[relative] = sha256(value);
  return value;
}

export async function textOptional(
  ctx: ReadContext,
  relative: string,
): Promise<string> {
  try {
    return (await readSafe(ctx, relative)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      issue(
        ctx,
        "warning",
        "read-error",
        `Could not read ${relative}: ${errorMessage(error)}`,
        [relative],
      );
    return "";
  }
}

export async function walk(
  ctx: ReadContext,
  relative: string,
): Promise<string[]> {
  const entries = await readdir(path.join(ctx.root, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      issue(
        ctx,
        "warning",
        "unsafe-path",
        `Skipped symbolic link while importing: ${child}`,
        [child],
      );
      continue;
    }
    if (entry.isDirectory()) files.push(...(await walk(ctx, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
