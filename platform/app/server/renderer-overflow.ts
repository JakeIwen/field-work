import type {
  ApplicationDocumentKind,
  DocumentOverflow,
} from "../shared/application-preparation.js";
import { runGenerationProcess } from "./generation-control.js";
import { parseOverflowLayout } from "./overflow-layout.js";

export function parseRendererOverflow(
  stderr: string,
  kind: ApplicationDocumentKind,
): DocumentOverflow | undefined {
  const match =
    /(?:Fatal error|Precondition failed):\s*Page\s+(\d+)\s+overflowed\s+by\s+((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+points\b/i.exec(
      stderr,
    );
  if (!match) return;
  const page = Number(match[1]),
    points = Number(match[2]);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isFinite(points) ||
    points <= 0
  )
    return;
  const layout = parseOverflowLayout(stderr, page);
  return { kind, page, points, ...(layout ? { layout } : {}) };
}

class RendererOverflowError extends Error {
  constructor(
    public overflow: DocumentOverflow,
    cause: Error,
    public stderr: string,
    public stdout: string,
  ) {
    super(cause.message, { cause });
  }
}

export async function runDocumentRenderer(
  store: Parameters<typeof runGenerationProcess>[0],
  kind: ApplicationDocumentKind,
  ...args: Parameters<typeof runGenerationProcess> extends [
    unknown,
    ...infer Rest,
  ]
    ? Rest
    : never
) {
  try {
    return await runGenerationProcess(store, ...args);
  } catch (error) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      const overflow = parseRendererOverflow(error.stderr, kind);
      if (overflow)
        throw new RendererOverflowError(
          overflow,
          error,
          error.stderr,
          "stdout" in error && typeof error.stdout === "string"
            ? error.stdout
            : "",
        );
    }
    throw error;
  }
}

export function rendererOverflowResult(error: unknown) {
  return error instanceof RendererOverflowError
    ? { overflow: error.overflow }
    : {};
}
