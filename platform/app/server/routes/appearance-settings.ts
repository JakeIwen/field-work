// Appearance writes from the theme editor: the active theme and the saved
// themes. Each has its own revision and leaves settings.version alone, so a
// theme save never invalidates a Settings form's pending edit.
import type { Request, Response } from "express";
import { normalizeKnobs, type Theme } from "theme-kit/core";
import {
  fieldworkKnobs,
  isBuiltinTheme,
  paletteSaveProblem,
  readSavedPalette,
  readSavedThemes,
  themeSaveProblem,
  type SavedActiveTheme,
  type SavedThemes,
} from "../../shared/palette.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";

export function saveActiveTheme(
  { store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const body = req.body ?? {};
  const old = store.settings();
  const problem = paletteSaveProblem(
    body.palette,
    readSavedThemes(old.themes).items,
  );
  if (problem) throw new HttpError(400, problem);
  const palette: SavedActiveTheme = {
    id: body.palette.id,
    knobs: normalizeKnobs(fieldworkKnobs, body.palette.knobs),
    revision: readSavedPalette(old.palette).revision + 1,
  };
  store.put("settings", "main", { ...old, palette });
  changed(res, palette);
}

export function saveTheme(
  { store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const body = req.body ?? {};
  const problem = themeSaveProblem(body.theme);
  if (problem) throw new HttpError(400, problem);
  const theme: Theme = {
    id: body.theme.id,
    name: body.theme.name.trim(),
    knobs: normalizeKnobs(fieldworkKnobs, body.theme.knobs),
  };
  const old = store.settings();
  const saved = readSavedThemes(old.themes);
  const items = saved.items.some((item) => item.id === theme.id)
    ? saved.items.map((item) => (item.id === theme.id ? theme : item))
    : [...saved.items, theme];
  const themes: SavedThemes = { items, revision: saved.revision + 1 };
  store.put("settings", "main", { ...old, themes });
  changed(res, themes);
}

export function deleteTheme(
  { store, changed }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const id = String(req.params.id);
  if (isBuiltinTheme(id))
    throw new HttpError(400, "Built-in themes can't be deleted");
  const old = store.settings();
  const saved = readSavedThemes(old.themes);
  if (!saved.items.some((item) => item.id === id))
    throw new HttpError(404, `No saved theme with id ${id}`);
  const themes: SavedThemes = {
    items: saved.items.filter((item) => item.id !== id),
    revision: saved.revision + 1,
  };
  store.put("settings", "main", { ...old, themes });
  changed(res, themes);
}
