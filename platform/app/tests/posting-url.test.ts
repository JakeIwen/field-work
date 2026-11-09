import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPostingUrl,
  postingIdentity,
  samePostingIdentity,
  normalizeCompanyName,
  normalizeTitle,
} from "../shared/posting-url.js";
import { canonicalUrl } from "../server/careers/providers.js";
import { canonicalPosting, samePostingUrls } from "../server/job-posting.js";

test("posting identity parses hosted Greenhouse, Lever, Ashby and Workday requisitions", () => {
  assert.deepEqual(
    postingIdentity("https://boards.greenhouse.io/acme/jobs/4012345?gh_src=x"),
    { ats: "greenhouse", board: "acme", jobId: "4012345" },
  );
  assert.deepEqual(
    postingIdentity("https://job-boards.greenhouse.io/Acme/jobs/4012345"),
    { ats: "greenhouse", board: "acme", jobId: "4012345" },
  );
  assert.deepEqual(
    postingIdentity("https://job-boards.eu.greenhouse.io/acme/jobs/77"),
    { ats: "greenhouse", board: "acme", jobId: "77" },
  );
  assert.deepEqual(
    postingIdentity(
      "https://boards.greenhouse.io/embed/job_app?for=acme&token=55",
    ),
    { ats: "greenhouse", board: "acme", jobId: "55" },
  );
  assert.deepEqual(
    postingIdentity(
      "https://acme.com/careers/job?gh_jid=4012345&utm_source=li",
    ),
    { ats: "greenhouse", board: null, jobId: "4012345" },
  );
  assert.deepEqual(
    postingIdentity(
      "https://jobs.lever.co/acme/0f1e2d3c-4b5a-6789-abcd-ef0123456789/apply",
    ),
    {
      ats: "lever",
      board: "acme",
      jobId: "0f1e2d3c-4b5a-6789-abcd-ef0123456789",
    },
  );
  assert.deepEqual(
    postingIdentity(
      "https://jobs.ashbyhq.com/Acme/0F1E2D3C-4B5A-6789-ABCD-EF0123456789/application",
    ),
    {
      ats: "ashby",
      board: "acme",
      jobId: "0f1e2d3c-4b5a-6789-abcd-ef0123456789",
    },
  );
  assert.deepEqual(
    postingIdentity(
      "https://acme.com/careers?ashby_jid=0f1e2d3c-4b5a-6789-abcd-ef0123456789",
    ),
    {
      ats: "ashby",
      board: null,
      jobId: "0f1e2d3c-4b5a-6789-abcd-ef0123456789",
    },
  );
  assert.deepEqual(
    postingIdentity(
      "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote-USA/Senior-Software-Engineer_R-01234",
    ),
    { ats: "workday", board: "acme/external", jobId: "R-01234" },
  );
  assert.deepEqual(
    postingIdentity(
      "https://acme.wd1.myworkdayjobs.com/Careers/job/Denver-CO/Staff-Engineer_JR123456-1",
    ),
    { ats: "workday", board: "acme/careers", jobId: "JR123456-1" },
  );
  assert.deepEqual(postingIdentity("https://example.com/jobs/123"), {
    ats: "other",
    board: null,
    jobId: null,
  });
  assert.deepEqual(postingIdentity("not a url"), {
    ats: "other",
    board: null,
    jobId: null,
  });
  // Greenhouse IDs are global; a gh_jid on an employer site matches the hosted board.
  assert.ok(
    samePostingIdentity(
      postingIdentity("https://acme.com/careers?gh_jid=9"),
      postingIdentity("https://boards.greenhouse.io/acme/jobs/9"),
    ),
  );
  // Workday requisition IDs only identify a vacancy within one tenant/site.
  assert.ok(
    !samePostingIdentity(
      postingIdentity("https://a.wd5.myworkdayjobs.com/X/job/L/Eng_R1"),
      postingIdentity("https://b.wd5.myworkdayjobs.com/X/job/L/Eng_R1"),
    ),
  );
  assert.ok(
    !samePostingIdentity(
      postingIdentity("https://example.com/1"),
      postingIdentity("https://example.com/1"),
    ),
  );
});

test("careers and import canonicalizers share one tracking-parameter set and keep requisition identities", () => {
  const urls = [
    "https://example.com/jobs/1/?utm_source=x&utm_campaign=y#apply",
    "https://example.com/jobs/1?ref=linkedin&source=feed",
    "https://example.com/jobs/1?referrer=abc&trackingId=9&gh_src=q",
    "https://jobs.lever.co/acme/abc?lever-source=li&lever-origin=applied",
    "https://EXAMPLE.com/jobs?gh_jid=1&utm_medium=z",
    "https://example.com/jobs?b=2&a=1",
  ];
  for (const url of urls) {
    assert.equal(canonicalUrl(url), canonicalPostingUrl(url), url);
    assert.equal(canonicalPosting(url), canonicalPostingUrl(url), url);
  }
  assert.equal(canonicalPostingUrl(urls[0]), "https://example.com/jobs/1");
  assert.equal(canonicalPostingUrl(urls[2]), "https://example.com/jobs/1");
  assert.equal(canonicalPostingUrl(urls[3]), "https://jobs.lever.co/acme/abc");
  assert.equal(
    canonicalPostingUrl(urls[4]),
    "https://example.com/jobs?gh_jid=1",
  );
  assert.equal(
    canonicalPostingUrl(urls[5]),
    "https://example.com/jobs?a=1&b=2",
  );
  assert.notEqual(
    canonicalPostingUrl("https://x.com/careers?ashby_jid=1"),
    canonicalPostingUrl("https://x.com/careers?ashby_jid=2"),
  );
  assert.equal(canonicalUrl("not a url"), "not a url");
  assert.equal(samePostingUrls(urls[0], urls[1]), true);
  assert.equal(samePostingUrls(urls[0], urls[4]), false);
  for (const invalid of ["not a url", "", "http://localhost/jobs/1"]) {
    assert.equal(samePostingUrls(invalid, invalid), false);
    assert.equal(samePostingUrls(invalid, urls[0]), false);
    assert.equal(samePostingUrls(urls[0], invalid), false);
  }
});

test("company and title normalization for cross-source matching", () => {
  assert.equal(normalizeCompanyName("The Acme Corp."), "acme");
  assert.equal(
    normalizeCompanyName("Acme, Inc."),
    normalizeCompanyName("ACME LLC"),
  );
  assert.notEqual(
    normalizeCompanyName("Acme Health"),
    normalizeCompanyName("Acme"),
  );
  assert.equal(
    normalizeTitle("Senior Software Engineer - Backend"),
    normalizeTitle("senior software engineer, backend"),
  );
  assert.equal(
    normalizeTitle("  Sr.  Engineer (Remote) "),
    "sr engineer remote",
  );
});
