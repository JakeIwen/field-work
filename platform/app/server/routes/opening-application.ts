import type { Express } from "express";
import { hostedApplication } from "../../shared/application-host.js";
import { fetchAutofillPage } from "../autofill/fetch.js";
import type { CareersFetch } from "../careers/http.js";
import { generationSignal } from "../generation-control.js";
import { loadGreenhouseApplication } from "../greenhouse-application-source.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError, type Store } from "../storage.js";

export async function openingApplicationUrl(
  store: Store,
  id: string,
  read: CareersFetch = (url) => fetchAutofillPage(url, generationSignal(store)),
) {
  const opening = store.opening(id);
  if (!opening) throw new HttpError(404, "Opening not found");
  const identity = hostedApplication(opening.url);
  if (identity?.provider !== "greenhouse")
    throw new HttpError(
      422,
      "This opening is not a hosted Greenhouse posting.",
    );
  // Use the same verified form as autofill: canonical job pages can redirect
  // to employer sites, while forcing embed URLs breaks existing normal scripts.
  const source = await loadGreenhouseApplication(identity, read);
  return source.applicationUrl;
}

export function registerOpeningApplication(
  app: Express,
  ctx: Pick<WorkspaceContext, "store">,
) {
  app.get("/api/openings/:id/application", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.redirect(
      302,
      await openingApplicationUrl(ctx.store, String(req.params.id)),
    );
  });
}
