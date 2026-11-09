import assert from "node:assert/strict";
import test from "node:test";
import {
  hostedApplication,
  sameHostedApplication,
} from "../shared/application-host.js";

test("hostedApplication preserves existing Greenhouse posting identity", () => {
  assert.deepEqual(
    hostedApplication("https://boards.greenhouse.io/Acme/jobs/12345"),
    {
      provider: "greenhouse",
      region: "global",
      host: "job-boards.greenhouse.io",
      board: "Acme",
      postingId: "12345",
      jobId: "12345",
      url: "https://job-boards.greenhouse.io/Acme/jobs/12345",
      applicationUrl: "https://job-boards.greenhouse.io/Acme/jobs/12345",
    },
  );
  assert.equal(
    sameHostedApplication(
      "https://boards.greenhouse.io/embed/job_app?for=Acme&token=12345",
      "https://job-boards.greenhouse.io/Acme/jobs/12345",
    ),
    true,
  );
});

test("hostedApplication rejects ambiguous or unsafe provider URLs", () => {
  const id = "12345678-90ab-cdef-1234-567890abcdef";
  const rejected = [
    `http://jobs.ashbyhq.com/board/${id}`,
    `https://user@jobs.ashbyhq.com/board/${id}`,
    `https://jobs.ashbyhq.com:443/board/${id}`,
    `https://jobs.ashbyhq.com.evil.example/board/${id}`,
    `https://jobs.ashbyhq.com/board/${id}/apply`,
    `https://jobs.lever.co/board/${id}/application`,
    `https://jobs.lever.co/board/not-a-uuid`,
    `https://jobs.lever.co/board%2Fother/${id}`,
    `https://jobs.lever.co/board/${id}%2Fapply`,
    `https://jobs.lever.co/board/${id}/apply/extra`,
  ];
  for (const value of rejected) assert.equal(hostedApplication(value), null);
  assert.equal(
    sameHostedApplication(
      "https://example.com/unsupported",
      "https://example.com/also-unsupported",
    ),
    false,
  );
  assert.equal(
    sameHostedApplication(
      `https://jobs.ashbyhq.com/board/${id}`,
      `https://jobs.lever.co/board/${id}`,
    ),
    false,
  );
});
