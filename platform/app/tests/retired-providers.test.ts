import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostedApplication } from "../shared/application-host.js";
import { supportsApplicationAutofill } from "../server/application-autofill-providers.js";
import { boardEndpoint, collectCompany } from "../server/careers/providers.js";
import { readCareersProviderFeed } from "../server/careers/provider-payloads.js";
import { validateOpening } from "../server/opening-validation.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { legacyAutofill, legacyOpening } from "./fixtures/legacy-records.js";
import { atomicWrite, sha256 } from "../server/storage.js";

const providers = [
  { provider: "ashby", host: "jobs.ashbyhq.com", action: "application" },
  { provider: "lever", host: "jobs.lever.co", action: "apply" },
] as const;
const postingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("retired providers cannot enter autofill, feed scans or availability checks", async () => {
  for (const { provider, host, action } of providers) {
    const url = `https://${host}/example/${postingId}`;
    for (const target of [url, `${url}/${action}`]) {
      assert.equal(hostedApplication(target), null);
      assert.equal(supportsApplicationAutofill(target), false);
      assert.equal(boardEndpoint(target), null);
    }
    assert.throws(
      () => readCareersProviderFeed(provider, { jobs: [] }),
      /Unsupported/,
    );
    const opening = legacyOpening({ url, job_id: postingId });
    let requests = 0;
    const noRead = async () => {
      requests++;
      throw Error("Must not contact retired provider");
    };
    const signal = new AbortController().signal;
    const verdict = await validateOpening(opening, noRead, signal);
    assert.equal(verdict.status, "unknown");
    assert.match(verdict.reason, /retired/);
    const scan = await collectCompany(
      {
        id: "example",
        name: "Example",
        fields: { "Careers URL": `https://${host}/example` },
      },
      { sources: [`https://${host}/example`] },
      [opening],
      noRead,
      signal,
      noRead,
    );
    assert.equal(scan.complete, false);
    assert.deepEqual(scan.jobs, []);
    assert.equal(scan.direct[postingId].status, "unknown");
    assert.equal(requests, 0);
  }
});

test("retired script downloads preserve exact bytes while new generation is rejected", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "retired-providers-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    for (const { provider, host } of providers) {
      const url = `https://${host}/example/${postingId}`;
      const opening = legacyOpening({ id: provider, url });
      workspace.store.put("custom_opening", opening.id, opening);
      const script = `// historical ${provider} fixture\n`;
      const record = legacyAutofill({
        id: provider,
        openingId: opening.id,
        provider,
        url,
        scriptHash: sha256(script),
      });
      atomicWrite(workspace.store.objectPath(record.scriptHash), script);
      workspace.store.put("application_autofill", record.id, record);
      const generated = await workspace.post(
        `/api/openings/${provider}/autofill`,
        {},
      );
      assert.equal(generated.status, 422);
      const download = await workspace.get(
        `/api/openings/${provider}/autofill/${record.id}?download=1`,
      );
      assert.equal(download.status, 200);
      assert.equal(await download.text(), script);
      assert.deepEqual(
        workspace.store.get("application_autofill", record.id),
        record,
      );
    }
    assert.equal(workspace.store.list("application_autofill").length, 2);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic career-page links and structured data cannot revive retired providers", async () => {
  const career = "https://example.invalid/careers";
  const urls: string[] = [];
  const jobs = providers.map(({ host }) => ({
    "@type": "JobPosting",
    title: "Senior Software Engineer",
    url: `https://${host}/example/${postingId}`,
    description: "Remote US software work",
    jobLocationType: "TELECOMMUTE",
  }));
  const html = `<main><script type="application/ld+json">${JSON.stringify(jobs)}</script>${jobs.map((job) => `<a href="${job.url}">${job.title}</a>`).join("")}</main>`;
  const result = await collectCompany(
    { id: "example", name: "Example", fields: { "Careers URL": career } },
    null,
    [],
    async (url) => {
      urls.push(url);
      assert.equal(url, career);
      return {
        url,
        requestedUrl: url,
        status: 200,
        type: "text/html",
        text: html,
        at: "2026-10-19T00:00:00Z",
      };
    },
    new AbortController().signal,
  );
  assert.deepEqual(urls, [career]);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.complete, false);
});
