import {
  preparationDefaultParallelRuns,
  preparationParallelRunBounds,
} from "../shared/preparation-settings.js";
import { HttpError, type Store } from "./storage.js";

export function validateParallelPreparations(value: unknown): number {
  const { min, max } = preparationParallelRunBounds;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(
      400,
      `Parallel preparations must be a whole number from ${min} to ${max}`,
    );
  return value;
}

export function parallelPreparations(store: Store): number {
  const saved = store.settings().parallelPreparations;
  const { min, max } = preparationParallelRunBounds;
  return typeof saved === "number" &&
    Number.isInteger(saved) &&
    saved >= min &&
    saved <= max
    ? saved
    : preparationDefaultParallelRuns;
}
