import type { Request, Response } from "express";
import {
  tunables,
  tunableProblem,
  tunablesProblem,
  tunablesConflict,
  tunablesRevision,
  type TunableKey,
} from "../../shared/tunables.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";

export function saveTunables(
  { store, changed, preparation, greenhousePull, gmail }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  const expected: unknown = req.body.expectedRevision;
  if (!Number.isInteger(expected) || (expected as number) < 0)
    throw new HttpError(400, "expectedRevision must be a whole number.");
  if (expected !== tunablesRevision(old))
    throw new HttpError(
      409,
      `${tunablesConflict} Reload the values before saving.`,
    );
  const values: unknown = req.body.values;
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new HttpError(
      400,
      "Tunable values must be an object keyed by tunable name.",
    );
  const overrides = { ...old.tunables };
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(tunables, key))
      throw new HttpError(400, `Unknown tunable "${key}".`);
    const problem = value === null ? null : tunableProblem(key, value);
    if (problem) throw new HttpError(400, problem);
    if (value === null) delete overrides[key as TunableKey];
    else overrides[key as TunableKey] = value as number;
  }
  const problem = tunablesProblem(overrides);
  if (problem) throw new HttpError(400, problem);
  // settings.version stays put: the pull forms use it for conflicts and pacing
  // bumps it during a pull, so tunables carry their own revision.
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      tunables: overrides,
      tunablesRevision: tunablesRevision(old) + 1,
    }),
  );
  preparation?.wake();
  greenhousePull?.wake();
  // Timers armed with an old delay: recompute them from the new values.
  gmail.rescheduleBackground();
  store.rescheduleExport();
}
