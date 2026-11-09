import { readSavedPalette, readSavedThemes } from "../shared/palette.js";
import { seedDemoAutofill } from "./demo-autofill.js";
import { captureGreenhousePolicy } from "../server/opening-pull/policy.js";
import {
  openingResearch,
  openingAssessments,
  pullActivity,
} from "./demo-content.js";
import { sha256, type Store } from "../server/storage.js";
import { saveFixturePdf } from "../tests/fixtures/document-records.js";
import { selectablePdf } from "../tests/fixtures/selectable-pdf.js";
import {
  legacyApplication,
  legacyOpening,
  legacyTask,
} from "../tests/fixtures/legacy-records.js";
import type { ApplicationStatus } from "../shared/types.js";

const companies = [
  "Northwind Studio",
  "Juniper Harbor",
  "Lumen Orchard",
  "Cedarline Labs",
  "Willow Atlas",
  "Copper Finch",
  "Daybreak Works",
  "Mosslight Systems",
  "Silver Fern Studio",
  "Paper Kite Labs",
  "Blue Mesa Tools",
  "Riverstone Cloud",
  "Aster Grove",
  "Ember Coast",
  "Maple Signal",
  "Clearwater Workshop",
];
const titles = [
  "Senior Full Stack Engineer",
  "Senior Frontend Engineer",
  "Product Engineer",
  "Backend Engineer",
  "Senior Software Engineer",
  "Platform Engineer",
  "Full Stack Engineer",
  "Staff Software Engineer",
];
const stages: ApplicationStatus[] = [
  "considering",
  "preparing",
  "ready",
  "applied",
  "interviewing",
  "offer",
  "rejected",
];

/** All records, document bytes and dates are synthetic; no live adapters are used. */
/** The owner's own saved theme, shown in the demo and the README screenshots. */
export const demoTheme = {
  id: "rosewood-slate",
  name: "Rosewood Slate",
  knobs: { hueNeutral: 360, hueBrand: 240, hueAccent: 70, chroma: 1.15 },
};

export async function seedDemo(store: Store, date = new Date()) {
  const at = (days: number) =>
    new Date(date.getTime() - days * 86400000).toISOString();
  const today = at(0);
  const theme = demoTheme;
  store.put("settings", "main", {
    ...store.settings(),
    palette: readSavedPalette({
      id: theme.id,
      knobs: theme.knobs,
      revision: 1,
    }),
    themes: readSavedThemes({ items: [theme], revision: 1 }),
  });
  seedOpenings(store, at);
  seedMaterials(store, today);
  seedMaterials(store, at(4), 5, "Willow Atlas");
  seedPull(store, at);
  seedFollowUp(store, today);
  seedConversation(store, at);
  await seedDemoAutofill(store);
  store.flushExport();
}

function seedMaterials(
  store: Store,
  at: string,
  number = 1,
  company = "Northwind Studio",
) {
  const prefix = number === 1 ? "demo" : `demo-${number}`;
  const lines = [
    "Sam Rivera",
    "Senior Full Stack Engineer",
    "sam.rivera@example.com | 202-555-0142",
    "PROFILE",
    "Full-stack engineer building dependable, accessible product workflows.",
    "EXPERIENCE",
    "Northwind Workshop | Senior Software Engineer",
    "Built React interfaces and Node.js APIs backed by PostgreSQL.",
    "Modernized mature services while preserving existing customer workflows.",
    "Designed integration tests around real data and public boundaries.",
    "SKILLS",
    "TypeScript | React | Node.js | PostgreSQL | AWS",
  ];
  const ids: string[] = [];
  for (const kind of ["resume", "cover-letter"] as const) {
    const text =
      kind === "resume"
        ? lines
        : [
            "Sam Rivera",
            `Dear ${company} team,`,
            "Your collaborative planning tools connect directly to my experience",
            "building accessible product interfaces and reliable backend services.",
            "At Northwind Workshop, I maintained React and Node.js workflows",
            "while modernizing integrations without disrupting existing users.",
            "I would welcome a conversation about the team's product challenges.",
            "Best,",
            "Sam Rivera",
          ];
    const doc = saveFixturePdf(
      store,
      {
        id: `${prefix}-${kind}`,
        logicalId: `${prefix}-${kind}`,
        kind,
        scope: "application",
        company,
        openingId: `demo-opening-${number}`,
        name: `Sam_Rivera_${company.replaceAll(" ", "_")}_${kind}.pdf`,
        version: "v1",
        versionNumber: 1,
        status: "current",
        createdAt: at,
        modifiedAt: at,
        authoredDate: at.slice(0, 10),
        text: text.join("\n"),
      },
      selectablePdf(text, kind === "resume" ? 2 : 1),
    );
    ids.push(doc.id);
  }
  seedApplicationMaterials(store, number, ids, at);
}

function seedApplicationMaterials(
  store: Store,
  number: number,
  ids: string[],
  at: string,
) {
  const app = store.get("application", `demo-application-${number}`);
  if (app)
    store.put("application", app.id, {
      ...app,
      documentIds: ids,
      ...(number === 5
        ? {
            packages: [
              {
                id: "demo-submitted-package",
                at,
                documents: ids.map((id) => {
                  const doc = store.document(id);
                  if (!doc) throw new Error("Missing demo PDF");
                  return {
                    id,
                    hash: doc.hash,
                    kind: doc.kind,
                    privacy: doc.privacy,
                  };
                }),
              },
            ],
          }
        : {}),
    });
}

function seedFollowUp(store: Store, at: string) {
  store.put("application_follow_up", "demo-application-5", {
    id: "demo-application-5",
    applicationId: "demo-application-5",
    openingId: "demo-opening-5",
    version: 1,
    createdAt: at,
    updatedAt: at,
    history: [],
    sent: [],
    testSends: [],
    draft: {
      id: "demo-follow-up-draft",
      to: "recruiting@example.com",
      subject: "Following up on the Senior Software Engineer application",
      body: "Hi Alex,\n\nThank you for arranging the engineering conversation. The team's approach to collaborative product development sounds closely connected to the work I have enjoyed most.\n\nThe examples we discussed are ready to share, including an API modernization and the tests that protected existing workflows. Please let me know if there is anything else that would be useful before Thursday.\n\nBest,\nSam Rivera",
      source: "edited",
      at,
    },
  });
}

function seedPull(store: Store, at: (days: number) => string) {
  const id = "demo-pull";
  store.put("greenhouse_pull_run", id, {
    id,
    clientRequestId: id,
    policy: captureGreenhousePolicy(store.settings(), at(0.04)),
    target: 10,
    status: "paused",
    phase: "Paused with saved search progress",
    queryIndex: 0,
    page: 3,
    limitCount: 0,
    cutoff: at(7),
    createdAt: at(0.04),
    updatedAt: at(0),
    parallelReviews: 6,
    searchLookahead: 6,
    pacingRate: 2000,
    queryPlan: [
      { query: "software engineer", page: 3, exhausted: false },
      { query: "full stack", page: 2, exhausted: false },
    ],
    pages: [
      {
        query: "software engineer",
        page: 1,
        ids: ["candidate-1", "candidate-2"],
        more: true,
        at: at(0.03),
        status: 200,
      },
      {
        query: "full stack",
        page: 1,
        ids: ["candidate-3"],
        more: true,
        at: at(0.02),
        status: 200,
      },
    ],
    failures: [],
    activity: pullActivity.map(([days, lane, text]) => ({
      at: at(days),
      lane,
      level: "info",
      text,
    })),
  });
  for (let i = 1; i <= 12; i++)
    store.put("greenhouse_pull_candidate", `${id}:candidate-${i}`, {
      id: `${id}:candidate-${i}`,
      runId: id,
      card: {
        board: "synthetic",
        firstPublished: at(1),
        id: `candidate-${i}`,
        title: titles[(i - 1) % titles.length],
        company: companies[(i - 1) % companies.length],
        url: `https://example.org/jobs/${i}`,
      },
      state: i <= 5 ? "added" : i <= 8 ? "excluded" : "discovered",
      ...(i <= 5 ? { openingId: `demo-opening-${i}`, reviewed: true } : {}),
      reason:
        i > 5 && i <= 8 ? "Outside the selected technical scope" : undefined,
    });
}

function seedConversation(store: Store, at: (days: number) => string) {
  const today = at(0);
  const question = legacyTask({
    id: "demo-question",
    status: "completed",
    preset: "questions",
    version: 1,
    createdAt: at(1),
    updatedAt: today,
    prompt: "How should I prepare for the Northwind engineering interview?",
    messages: [
      {
        role: "user",
        text: "How should I prepare for the Northwind engineering interview?",
      },
      {
        role: "assistant",
        text: "Focus on three concrete examples: modernizing a mature interface without disrupting users, designing a dependable API, and diagnosing a production issue across frontend and backend boundaries.\n\nFor each, explain the constraint, your decision and the result. Ask the team how they share support work, review changes and protect focused development time.",
      },
    ],
  });
  store.put("task", question.id, question);
  store.put("employer_reply", "demo-reply", {
    id: "demo-reply",
    messageId: "synthetic-message",
    threadId: "synthetic-thread",
    account: "sam.rivera@example.com",
    sender: "Alex Morgan <recruiting@example.com>",
    subject: "Next steps: engineering conversation",
    receivedAt: today,
    detectedAt: today,
    excerpt:
      "Thank you for sharing your work. We would like to schedule a conversation with the engineering team this Thursday.",
    kind: "interview",
    applicationIds: ["demo-application-5"],
    reason: "Synthetic interview invitation linked to the saved application.",
  });
}

function seedOpenings(store: Store, at: (days: number) => string) {
  companies.forEach((company, i) => {
    const id = `demo-opening-${i + 1}`;
    const opening = demoOpening(i, at);
    const hash = opening.hash;
    store.put("custom_opening", id, opening);
    store.put("personal", id, {
      id,
      version: 1,
      saved: i % 3 === 0,
      dismissed: i === 14,
      reviewedHash: i % 3 === 0 ? hash : undefined,
    });
    if (i < 10) seedApplication(store, i, at);
  });
}

function seedApplication(
  store: Store,
  i: number,
  at: (days: number) => string,
) {
  const id = `demo-opening-${i + 1}`;
  const status = stages[i % stages.length];
  const sent = ["applied", "interviewing", "offer", "rejected"].includes(
    status,
  );
  const application = legacyApplication({
    id: `demo-application-${i + 1}`,
    openingId: id,
    status,
    createdAt: at(6),
    updatedAt: at(0),
    version: 1,
    ...(sent
      ? { submittedAt: at(4), applicationDate: at(4).slice(0, 10) }
      : {}),
    nextAction:
      status === "interviewing"
        ? "Meet the engineering team on Thursday"
        : status === "offer"
          ? "Review the written offer and benefits"
          : "Review the role and prepare questions",
    contacts: "Alex Morgan · recruiting@example.com",
    notes: "Synthetic application for the public demo.",
  });
  store.put("application", application.id, application);
  store.journal(
    "application_status",
    `Application moved to ${status}`,
    application.id,
    { openingId: id },
  );
}

function demoOpening(i: number, at: (days: number) => string) {
  const id = `demo-opening-${i + 1}`;
  const company = companies[i];
  const today = at(0);
  const hash = sha256(`synthetic-posting-${i}`);
  const technical = ["High", "High", "Medium", "High", "Low"][i % 5];
  const wlb = ["High", "Medium", "Uncertain", "Unknown", "Low"][i % 5];
  return legacyOpening({
    id,
    company_id: `demo-company-${i + 1}`,
    company,
    job_id: `demo-${i + 1}`,
    title: titles[i % titles.length],
    url: `https://job-boards.greenhouse.io/northwindexample/jobs/${1001 + i}`,
    technical_fit: technical,
    remote_fit: i % 6 === 4 ? "Medium" : "High",
    wlb_outlook: wlb,
    location: i % 3 === 0 ? "Remote · United States" : "Remote · North America",
    compensation: `$${140 + i * 2},000–$${175 + i * 2},000 USD annual base`,
    salaryBands: [
      {
        min: (140 + i * 2) * 1000,
        max: (175 + i * 2) * 1000,
        currency: "USD",
      },
    ],
    salaryKind: "annual",
    ...openingResearch,
    concerns:
      i % 4 === 2
        ? "Team hours and on-call rotation need clarification during the interview."
        : "Confirm core collaboration hours and team-level vacation usage.",
    hash,
    status: "NEW",
    postingStatus: i === 15 ? "closed" : "open",
    first_seen: at(i % 7).slice(0, 10),
    first_published: at((i % 7) + 1).slice(0, 10),
    last_confirmed_open: today.slice(0, 10),
    createdAt: at(i % 7),
    firstImportedAt: at(i % 7),
    assessmentSourceHash: hash,
    listSummarySourceHash: hash,
    skillsSourceHash: hash,
    assessmentDetails: openingAssessments,
    listSummary: {
      location: "US remote",
      technicalFit: `${technical} · React / Node.js`,
      wlbOutlook: `${wlb} · Verify team hours`,
      compensation: `$${140 + i * 2}k–$${175 + i * 2}k USD base`,
    },
    skills: {
      required:
        i % 3 === 0
          ? ["React", "TypeScript", "Node.js", "PostgreSQL"]
          : ["TypeScript", "Node.js", "PostgreSQL"],
      anyOf: [["AWS", "Google Cloud"]],
      preferred: ["Docker", "GraphQL"],
    },
    sources: [`https://example.com/careers/${i + 1}`],
  });
}
