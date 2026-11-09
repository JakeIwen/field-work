import path from "node:path";
import { atomicWrite, type Store } from "../server/storage.js";
import { generateAutofill } from "../server/application-autofill.js";
import type { CareersFetch } from "../server/careers/http.js";

/** Exercise the real planner/packager using only in-memory fictional form responses. */
export async function seedDemoAutofill(store: Store) {
  atomicWrite(
    path.join(store.root, ".local/greenhouse/profile.json"),
    JSON.stringify({
      version: 1,
      firstName: "Sam",
      lastName: "Rivera",
      email: "sam.rivera@example.com",
    }),
  );
  const api = {
    id: 1001,
    title: "Senior Full Stack Engineer",
    company_name: "Northwind Studio",
    content:
      "Build accessible React interfaces and reliable Node.js APIs with PostgreSQL.",
    questions: [
      { label: "First Name", fields: [{ name: "first_name" }] },
      { label: "Last Name", fields: [{ name: "last_name" }] },
      { label: "Email", fields: [{ name: "email" }] },
    ],
  };
  const html =
    '<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="last_name">Last Name</label><input id="last_name"><label for="email">Email</label><input id="email"></form>';
  // This collaborator returns fixture bytes directly: no fetch, socket or browser.
  const read: CareersFetch = async (url) => ({
    url,
    requestedUrl: url,
    status: 200,
    type: "text/html",
    text: url.includes("boards-api") ? JSON.stringify(api) : html,
    at: new Date().toISOString(),
  });
  await generateAutofill(store, "demo-opening-1", read);
}
