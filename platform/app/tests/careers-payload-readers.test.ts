import test from "node:test";
import assert from "node:assert/strict";
import {
  payloadProperty,
  readCareersProviderFeed,
  readOptionalWorkdayPostingDetail,
  readStructuredJobPostings,
  readWorkdayInventory,
} from "../server/careers/provider-payloads.js";
import {
  readCareerCompanyResults,
  readCareerScanBaseline,
  readCareerScanManifest,
  readCompanyScan,
} from "../server/careers/scan-records.js";

const at = "2026-10-15T12:00:00.000Z";

test("provider feed readers accept current Greenhouse shapes", () => {
  const greenhouse = readCareersProviderFeed("greenhouse", {
    jobs: [
      {
        id: 17,
        absolute_url: "https://job-boards.greenhouse.io/example/jobs/17",
        location: { name: "Remote" },
      },
    ],
    meta: { total: 1 },
  });
  assert.equal(greenhouse.kind, "greenhouse");
  assert.deepEqual(greenhouse.rows[0], {
    id: 17,
    content: undefined,
    title: undefined,
    absoluteUrl: "https://job-boards.greenhouse.io/example/jobs/17",
    locationName: "Remote",
    internalJobId: undefined,
  });
});

test("provider readers preserve optional fallbacks and reject malformed containers", () => {
  const workday = readWorkdayInventory({
    total: 0,
    jobPostings: [
      {
        title: "Engineer",
        externalPath: "/job/Remote/Engineer_R1",
      },
    ],
  });
  assert.equal(workday.total, 0);
  assert.deepEqual(workday.jobPostings[0].bulletFields, []);
  assert.equal(workday.jobPostings[0].locationsText, "");
  assert.equal(
    readOptionalWorkdayPostingDetail({ error: "not found" }),
    undefined,
  );
  assert.throws(
    () => readCareersProviderFeed("greenhouse", { jobs: {} }),
    /jobs array/,
  );
  assert.throws(
    () => readWorkdayInventory({ total: "1", jobPostings: [] }),
    /shape is invalid/,
  );
});

test("nonconformant scalar fields retain the legacy values that scans accepted", () => {
  const workday = readWorkdayInventory({
    total: 1,
    jobPostings: [
      {
        title: 42,
        externalPath: "/job/Remote/Engineer_R1",
        locationsText: 7,
      },
    ],
  });
  assert.equal(workday.jobPostings[0].title, 42);
  assert.equal(workday.jobPostings[0].locationsText, 7);

  const [structured] = readStructuredJobPostings({
    "@type": "JobPosting",
    identifier: 9,
    url: 10,
    validThrough: false,
  });
  assert.equal(structured.identifier, 9);
  assert.equal(structured.url, 10);
  assert.equal(structured.validThrough, false);
});

test("structured posting reader walks graphs without reordering jobs", () => {
  const jobs = readStructuredJobPostings({
    "@graph": [
      { "@type": "Thing", name: "ignore" },
      {
        "@type": ["Thing", "JobPosting"],
        identifier: { value: "R1" },
        title: "First",
        url: "https://example.com/jobs/first",
      },
      {
        "@graph": [
          {
            "@type": "JobPosting",
            identifier: "R2",
            title: "Second",
            url: "https://example.com/jobs/second",
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    jobs.map((job) => job.title),
    ["First", "Second"],
  );
  assert.equal(payloadProperty(jobs[0].identifier, "value"), "R1");
  assert.equal(jobs[1].identifier, "R2");
});

test("scan record readers accept saved records and fail closed on malformed data", () => {
  assert.deepEqual(readCareerCompanyResults({}), []);
  assert.deepEqual(
    readCareerCompanyResults({
      company_results: [{ company_id: "example", result: "SUCCESS" }],
    }).map((row) => row.company_id),
    ["example"],
  );
  assert.throws(
    () => readCareerCompanyResults({ company_results: {} }),
    /company results/,
  );

  const companyScan = {
    company_id: "example",
    company: "Example",
    result: "SUCCESS",
    inventory_count: 0,
    complete: true,
    sources: ["https://jobs.example.com"],
    notes: "Complete",
    checked_at: at,
    jobs: [],
    direct: {},
  };
  assert.equal(readCompanyScan(companyScan), companyScan);
  assert.throws(
    () => readCompanyScan({ ...companyScan, jobs: [null] }),
    /company scan is invalid/,
  );

  assert.deepEqual(
    readCareerScanBaseline({ previous: {}, openings: [], history: "history" }),
    { previous: {}, openings: [], history: "history" },
  );
  assert.deepEqual(
    readCareerScanManifest({
      phase: "prepared",
      snapshot: "company_careers/research/scans/example",
      files: [{ path: "state.json", beforeHash: "a", afterHash: "b" }],
    }).files,
    [{ path: "state.json", beforeHash: "a", afterHash: "b" }],
  );
});
