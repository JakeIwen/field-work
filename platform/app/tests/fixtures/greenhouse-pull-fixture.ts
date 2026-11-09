import type { ModelSelection } from "../../shared/model-selection.js";
import type { Records } from "../../server/records.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../../server/storage.js";
import {
  GreenhousePullManager,
  stageGreenhouseDecision,
  type PullCandidate,
} from "../../server/greenhouse-pull.js";
import {
  searchUrl,
  type GreenhouseCard,
  type GreenhouseSource,
  type GreenhousePosting,
} from "../../server/greenhouse-source.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./sample-workspace.js";

export const at = Date.parse("2026-09-28T20:00:00Z");
export const card = (id: string): GreenhouseCard => ({
  id,
  board: "example",
  title: `Software Engineer ${id}`,
  company: "Example",
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  firstPublished: "2026-09-25T12:00:00Z",
});
export const posting = (c: GreenhouseCard): GreenhousePosting => ({
  raw: {
    id: Number(c.id),
    internal_job_id: `req-${c.id}`,
    first_published: c.firstPublished,
    title: c.title,
  },
  text: "Build and maintain React and Node.js software, SQL-backed applications using PostgreSQL or MySQL, and integrations. Fully remote within the United States. Base salary $150,000–$190,000. On-call rotation is not specified.",
  aliases: [c.id],
  apiUrl: `https://boards-api.greenhouse.io/v1/boards/example/jobs/${c.id}`,
  fetchedAt: new Date(at).toISOString(),
});
export function research(c: PullCandidate) {
  return {
    opening: {
      title: c.card.title,
      jobId: c.card.id,
      description: c.posting!.text,
      location: "Remote US",
      compensation: "$150,000–$190,000 USD annual base",
      technicalFit: "High",
      remoteFit: "High",
      wlbOutlook: "Uncertain",
      assessmentDetails: {
        technicalFit:
          "React, Node.js and relational data overlap with established experience.",
        remoteFit:
          "Explicit US remote; eligible states and interstate mobile work still require confirmation.",
        wlbOutlook: "Actual hours and on-call burden are not published.",
      },
      skills: {
        required: ["React", "Node.js", "SQL"],
        anyOf: [["PostgreSQL", "MySQL"]],
        preferred: [],
      },
      listSummary: {
        location: "Remote US",
        technicalFit: "High",
        wlbOutlook: "Uncertain",
        compensation: "$150,000–$190,000 USD base",
      },
      firstPublishedAt: c.posting!.raw.first_published,
      deadline: null,
      dateSources: { firstPublishedAt: c.posting!.apiUrl, deadline: null },
      why: "Full-stack product engineering overlap.",
      concerns: "Confirm mobile working and on-call.",
      wlbEvidence: "On-call and actual hours unspecified.",
      postingStatus: "open",
    },
    company: {
      companyId: "",
      name: "Example",
      officialUrl: "https://example.com",
      careersUrl: "https://example.com/careers",
      description: "Software product company.",
      contactInfo: "https://example.com",
      contactType: "url",
      contactSourceUrl: "https://example.com",
    },
    sources: [c.posting!.apiUrl, "https://example.com"],
  };
}
export function fixture(
  custom: Partial<GreenhouseSource> = {},
  options: { autoStart?: boolean } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fieldwork-greenhouse-"));
  const store = new Store(repositoryRoot, dir);
  let clock = at;
  const calls: any[] = [];
  const source: GreenhouseSource = {
    page: async (query, page, employmentTypes) => {
      calls.push({ query, page });
      return {
        query,
        employmentTypes,
        page,
        cards: page === 1 ? [card("1"), card("2"), card("3")] : [],
        more: false,
        url: searchUrl(query, page, employmentTypes),
        at: new Date(clock).toISOString(),
        status: 200,
      };
    },
    posting: async (c) => {
      calls.push({ posting: c.id });
      return posting(c);
    },
    close: async () => {},
    ...custom,
  };
  const deps = {
    ...reviewDependencies(store, source, calls, () => clock),
    ...options,
  };
  let manager = new GreenhousePullManager(store, deps);
  return {
    store,
    calls,
    review: deps,
    get manager() {
      return manager;
    },
    setTime: (time: number) => {
      clock = time;
    },
    restart: async () => {
      await manager.close();
      manager = new GreenhousePullManager(store, deps);
    },
    finish: (skip = false, publicId?: string) =>
      finishReview(store, skip, publicId),
    close: async () => {
      await manager.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function advanceUntil(
  f: ReturnType<typeof fixture>,
  ready: () => boolean,
  limit = 80,
) {
  for (let step = 0; step < limit && !ready(); step++) await f.manager.tick();
  assert.ok(
    ready(),
    `Pull did not reach the expected state: ${JSON.stringify(f.manager.state())}`,
  );
}

function finishReview(store: Store, skip: boolean, publicId?: string) {
  const c = store
    .list("greenhouse_pull_candidate")
    .find(
      (c) =>
        c.taskId &&
        store.get("task", c.taskId)?.status === "running" &&
        (!publicId || c.card.id === publicId),
    ) as PullCandidate;
  assert.ok(c, "a running review exists");
  const task = store.get("task", c.taskId!)!;
  stageGreenhouseDecision(
    store,
    task,
    skip
      ? {
          decision: "excluded",
          reason:
            "Exact duties are sales operations rather than software development.",
          softwareAssessment:
            "Maintains sales reports; no software engineering duties.",
          remoteAssessment: "US remote in the official source.",
          fitAssessment: "Not a software development opportunity.",
          sources: [c.posting!.apiUrl],
        }
      : research(c),
    skip,
  );
  store.put(
    "task",
    task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    {
      ...store.get("task", task.id),
      status: "completed",
    } as Records["task"],
  );
  return c;
}

function reviewDependencies(
  store: Store,
  source: GreenhouseSource,
  calls: Record<string, string | number>[],
  clock: () => number,
) {
  let creates = 0;
  return {
    source,
    clock,
    autoStart: false,
    formCheckRead: async (): Promise<never> => {
      throw new Error("fixture: no network");
    },
    notify: () => {},
    defaultModel: (): string | undefined => undefined,
    interruptTask: async (id: string) => {
      calls.push({ interrupt: id });
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        {
          ...store.get("task", id),
          status: "interrupted",
        } as Records["task"],
      );
    },
    createResearch: async (r: any, c: PullCandidate) => {
      const id = `task-${++creates}`;
      const task = {
        id,
        preset: "opening-research",
        importUrl: c.card.url,
        status: "handoff",
        greenhousePull: { runId: r.id, candidateId: c.id },
      };
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        task as Records["task"],
      );
      return store.get("task", id);
    },
    startTask: async (id: string, selection?: Partial<ModelSelection>) => {
      const task = store.get("task", id);
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        {
          ...task,
          ...selection,
          status: "running",
          threadId: id,
        } as Records["task"],
      );
      return task;
    },
  };
}
