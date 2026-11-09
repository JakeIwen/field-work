import path from "node:path";
import { repositoryRoot } from "../server/paths.js";
import { Store } from "../server/storage.js";
import { saveFixturePdf } from "../tests/fixtures/document-records.js";
import {
  legacyApplication,
  legacyOpening,
} from "../tests/fixtures/legacy-records.js";
import { selectablePdf } from "../tests/fixtures/selectable-pdf.js";

const dataDirectory = path.resolve(process.argv[2] ?? "");
if (
  !process.argv[2] ||
  !path.basename(dataDirectory).startsWith("fieldwork-browser-fixture-")
) {
  throw new Error(
    "Pass a disposable data directory named fieldwork-browser-fixture-*",
  );
}

const store = new Store(repositoryRoot, dataDirectory);
try {
  const opening = legacyOpening({
    id: "browser-fixture-opening",
    company_id: "browser-fixture-company",
    company: "Browser Fixture Company",
    job_id: "fixture-1",
    title: "Fixture Engineer",
    url: "https://example.test/jobs/fixture-1",
    technical_fit: "High",
    remote_fit: "High",
    wlb_outlook: "Unknown",
    location: "US remote",
    compensation: "$140,000 fixture",
    why: "Browser verification fixture",
    status: "NEW",
    postingStatus: "open",
    first_seen: "2026-10-20",
    last_confirmed_open: "2026-10-20",
    hash: "browser-fixture-opening-hash",
  });
  store.put("custom_opening", opening.id, opening);

  const lines = [
    "Sam Rivera",
    "sam.rivera@example.com",
    "Browser verification fixture with selectable PDF text.",
    "This synthetic document contains no personal workflow data.",
  ];
  const current = saveFixturePdf(
    store,
    {
      id: "browser-fixture-resume-current",
      logicalId: "browser-fixture-resume",
      kind: "resume",
      scope: "general",
      privacy: "private",
      origin: "generated",
      name: "2026-10-20_browser-fixture_resume_private_v2.pdf",
      company: null,
      version: "v2",
      versionNumber: 2,
      status: "current",
      createdAt: "2026-10-20T00:00:00Z",
      modifiedAt: "2026-10-20T00:00:00Z",
      authoredDate: "2026-10-20",
      text: lines.join("\n"),
    },
    selectablePdf(lines, 2),
  );
  saveFixturePdf(
    store,
    {
      ...current,
      id: "browser-fixture-resume-older",
      version: "v1",
      versionNumber: 1,
      status: "historical",
      name: "2026-10-19_browser-fixture_resume_private_v1.pdf",
      createdAt: "2026-10-19T00:00:00Z",
      modifiedAt: "2026-10-19T00:00:00Z",
      authoredDate: "2026-10-19",
    },
    selectablePdf([...lines, "Earlier fixture revision."], 2),
  );

  const application = legacyApplication({
    id: "browser-fixture-application",
    openingId: opening.id,
    status: "interviewing",
    submittedAt: "2026-10-20T12:00:00Z",
    documentIds: [current.id],
    version: 1,
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-20T12:00:00Z",
    packages: [
      {
        id: "browser-fixture-package",
        at: "2026-10-20T12:00:00Z",
        documents: [
          {
            id: current.id,
            hash: current.hash,
            kind: current.kind,
            privacy: current.privacy,
          },
        ],
      },
    ],
  });
  store.put("application", application.id, application);
  store.flushExport();
  console.log(
    JSON.stringify({
      dataDirectory,
      openingId: opening.id,
      applicationId: application.id,
      documentId: current.id,
    }),
  );
} finally {
  store.close();
}
