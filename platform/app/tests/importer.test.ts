import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RescanProgress } from "../shared/rescan-progress.js";
import {
  authoredDate,
  htmlText,
  importRepository,
  isLegacyResumeDocument,
  parseCompanies,
  parseOpenings,
  salaryBands,
} from "../server/importer.js";

const company = `# Watchlist\n\n## 01. Example\n<!-- company_id: example -->\n- **Careers URL:** https://example.test/jobs\n- **Monitoring priority:** B\n- **Last researched:** 2026-09-05\n- **Remote compatibility:** US remote, supported states unknown.\n`;
const opening = `# Current opportunities\n- **Scan completed:** 2026-09-05T12:00:00Z\n\n### Example — Senior Full Stack Engineer\n<!-- company_id: example; job_id: R1 -->\n* **Job URL:** [Official posting](https://example.test/jobs/R1)\n* **Location / remote status:** US remote, approved states unknown.\n* **Compensation:** $160,900–$257,100 in CA; $152,900–$244,300 in CO. Equity separate.\n* **Technical fit:** High\n* **Remote fit:** High\n* **WLB outlook:** Uncertain\n* **Overall priority:** B\n* **Status:** NEW\n* **Why it fits:** React, Node.js and relational data.\n* **Main concerns:** Pager frequency unknown. Published application end date: 2026-09-11.\n* **Key requirements:** React and Node.js\n* **Useful WLB evidence:** Hours not specified.\n* **First seen:** 2026-09-05\n* **Last confirmed open:** 2026-09-05\n`;

test("research imports ignore historical priority fields and do not require them", () => {
  const importedCompany = parseCompanies(company)[0];
  const importedOpening = parseOpenings(opening)[0];
  assert.equal(Object.hasOwn(importedCompany, "priority"), false);
  assert.equal(
    Object.hasOwn(importedCompany.fields, "Monitoring priority"),
    false,
  );
  assert.equal(Object.hasOwn(importedOpening, "priority"), false);
  const withoutCompanyPriority = parseCompanies(
    company.replace(/- \*\*Monitoring priority:\*\* B\n/, ""),
  )[0];
  assert.equal(withoutCompanyPriority.id, importedCompany.id);
  assert.deepEqual(withoutCompanyPriority.fields, importedCompany.fields);
  // The retired value stays in the content fingerprint so existing hashes, and the
  // reviews and materials bound to them, survive the removal.
  const withoutPriority = parseOpenings(
    opening.replace(/\* \*\*Overall priority:\*\* B\n/, ""),
  )[0];
  assert.notEqual(withoutPriority.hash, importedOpening.hash);
  const unhashed = (o: object) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !/hash$/i.test(k)));
  assert.deepEqual(unhashed(withoutPriority), unhashed(importedOpening));
});

test("import progress measures document and snapshot attempts, including failed snapshots", async () =>
  fixture(async (root) => {
    const progress: RescanProgress[] = [];
    const result = await importRepository(root, (p) => progress.push(p));
    assert.equal(progress[0].phase, "research");
    assert.equal(progress.at(-1)?.phase, "reconcile");
    for (const phase of ["documents", "snapshots"] as const) {
      const updates = progress.filter((p) => p.phase === phase);
      const total = updates[0].total!;
      assert.ok(total > 0);
      assert.deepEqual(
        updates.map((p) => p.completed),
        Array.from({ length: total + 1 }, (_, i) => i),
      );
      assert.ok(updates.every((p) => p.total === total));
    }
    assert.equal(
      progress.filter((p) => p.phase === "documents").at(-1)?.completed,
      result.documents.length,
    );
    await writeFile(
      path.join(
        root,
        "company_careers/research/scans/2026-09-05/qualified_openings.json",
      ),
      "broken JSON",
    );
    progress.length = 0;
    const failed = await importRepository(root, (p) => progress.push(p));
    const last = progress.filter((p) => p.phase === "snapshots").at(-1)!;
    assert.equal(last.completed, last.total);
    assert.ok(failed.health.some((h) => h.category === "invalid-snapshot"));
    assert.equal(progress.at(-1)?.phase, "reconcile");
  }));

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-search-import-"));
  try {
    for (const dir of [
      "company_careers/research/scans/2026-09-05",
      "source_master_template/v10",
      "source_master_template/v9",
      "source_master_template/v2_bad",
      "employer_specific",
      "old_resume",
      "source_data",
    ])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, "company_careers/companies.md"), company);
    await writeFile(
      path.join(root, "company_careers/current_openings.md"),
      opening,
    );
    await writeFile(
      path.join(root, "source_data/README.md"),
      "- current general content master, synchronized to `source_master_template/v10/` on September 5, 2026.",
    );
    await writeFile(
      path.join(root, "source_data/resume.md"),
      "# Resume\nEngineering, 2018–2026\n",
    );
    const scan = {
      last_scan_completed: "2026-09-05T12:00:00Z",
      active_company_ids: ["example"],
      current_opening_keys: ["example:R1"],
      seen_jobs: {
        "example:R1": { first_seen: "2026-09-05" },
        "example:R2": {},
      },
      company_results: [
        {
          company_id: "example",
          company: "Example",
          result: "SUCCESS",
          notes: "Current posting confirmed.",
          sources: [],
        },
      ],
    };
    await writeFile(
      path.join(root, "company_careers/scan_state.json"),
      JSON.stringify(scan),
    );
    await writeFile(
      path.join(
        root,
        "company_careers/research/scans/2026-09-05/company_results.json",
      ),
      JSON.stringify(scan.company_results),
    );
    await writeFile(
      path.join(
        root,
        "company_careers/research/scans/2026-09-05/qualified_openings.json",
      ),
      JSON.stringify({
        scan_timestamp: scan.last_scan_completed,
        openings: parseOpenings(opening),
      }),
    );
    await writeFile(
      path.join(
        root,
        "company_careers/research/scans/2026-09-05/selected-source-jobs.json",
      ),
      "[]",
    );
    await writeFile(
      path.join(root, "source_master_template/v10/resume.html"),
      "<h1>Sam</h1><p>Phone: 123-456-7890</p><p>Production engineering.</p>",
    );
    await writeFile(
      path.join(root, "source_master_template/v10/resume_public.html"),
      "<h1>Sam</h1><p>Production engineering.</p>",
    );
    await writeFile(
      path.join(root, "source_master_template/v10/revision_notes.md"),
      "Reviewed September 5, 2026 against v9.",
    );
    await writeFile(
      path.join(root, "source_master_template/v9/resume.html"),
      "<p>Earlier engineering</p>",
    );
    await writeFile(
      path.join(root, "source_master_template/v2_bad/resume.html"),
      "<p>Rejected draft</p>",
    );
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("stable company and requisition identities, source labels and date-only deadlines", () => {
  assert.equal(parseCompanies(company)[0].id, "example");
  const result = parseOpenings(opening)[0];
  assert.equal(result.id, "example:R1");
  assert.equal(result.deadline, "2026-09-11");
  assert.equal(result.status, "NEW");
  assert.equal(result.postingStatus, "confirmed open at last scan");
  assert.equal(result.sourceDate, "2026-09-05T12:00:00Z");
  assert.match(result.compensation, /in CA; .* in CO/);
  assert.equal((result.salaryBands as any[]).length, 2);
});

test("invalid or duplicate Markdown is rejected as a whole; declared empty scans are allowed", () => {
  assert.throws(
    () => parseCompanies(company + company.slice(company.indexOf("## "))),
    /Duplicate company/,
  );
  assert.throws(
    () => parseOpenings(opening + opening.slice(opening.indexOf("### "))),
    /Duplicate opening/,
  );
  assert.throws(
    () =>
      parseOpenings(
        opening.replace("<!-- company_id: example; job_id: R1 -->", ""),
      ),
    /stable/,
  );
  assert.throws(
    () => parseCompanies("half-written temporary contents"),
    /No valid/,
  );
  assert.deepEqual(parseOpenings("- **Qualifying current openings:** 0"), []);
});

test("salary assistance preserves geographic bands, distinguishes unknown and historical pay", () => {
  assert.deepEqual(salaryBands("Not published in this posting."), []);
  assert.deepEqual(
    salaryBands("Historical $140k–$210k. Current band unknown."),
    [],
  );
  assert.deepEqual(
    salaryBands(
      "Current posting says competitive pay but publishes no range. Earlier $140k–$210k evidence is not a current quote.",
    ),
    [],
  );
  assert.deepEqual(
    salaryBands(
      "Expired posting advertised $140k–$210k. Current salary is unknown.",
    ),
    [],
  );
  assert.deepEqual(salaryBands("$140k–$210k is not a current quote."), []);
  assert.equal(
    salaryBands("Earlier $140k–$190k; current published base $170k–$210k.")
      .length,
    1,
  );
  assert.equal(
    salaryBands("$178,500 annual pay; stock separate.")[0].min,
    178500,
  );
  assert.equal(salaryBands("$140k–$190k")[0].max, 190000);
  assert.equal(salaryBands("$140,000–$190k")[0].min, 140000);
  assert.deepEqual(
    salaryBands("Base $160k–$190k; bonus $20k; $40k equity").map(
      (b) => b.basis,
    ),
    ["published base", "bonus", "equity"],
  );
  assert.equal(
    salaryBands("Equity separate. $160k–$190k base.")[0].basis,
    "published base",
  );
  assert.equal(
    salaryBands("Equity separate; base $160k–$190k.")[0].basis,
    "published base",
  );
  assert.equal(
    salaryBands("$160k–$190k equity separate.")[0].basis,
    "published base",
  );
});

test("HTML readable text excludes executable content and preserves useful structure", () => {
  const text = htmlText(
    '<style>secret-css</style><h1>Resume</h1><p>React<br>Node.js</p><script>fetch("secret")</script><iframe>secret-frame</iframe>',
  );
  assert.match(text, /Resume\nReact\nNode.js/);
  assert.doesNotMatch(text, /secret|fetch/);
});

test("employment dates, invalid dates and mtime never establish authored date", () => {
  assert.equal(
    authoredDate("# Resume\nEngineer June 2015 to August 2023"),
    null,
  );
  assert.equal(authoredDate("I updated September 5, 2026 user data."), null);
  assert.equal(authoredDate("Reviewed February 30, 2026"), null);
  assert.equal(
    authoredDate("Reviewed September 5, 2026 against earlier versions."),
    "2026-09-05",
  );
  assert.equal(authoredDate("Date: 2026-09-05"), "2026-09-05");
});

test("repeat imports are idempotent, v10 sorts numerically, rejected and uncertain legacy versions remain distinct", async () =>
  fixture(async (root) => {
    const first = await importRepository(root),
      second = await importRepository(root);
    assert.equal(first.companies.length, 1);
    assert.equal(first.openings.length, 1);
    assert.equal(first.scan.seenCount, 2);
    assert.deepEqual(
      first.documents.map((d) => d.id),
      second.documents.map((d) => d.id),
    );
    assert.equal(
      first.documents.find((d) => d.path.includes("/v9/"))?.authoredDate,
      null,
    );
    assert.equal(
      first.documents.find((d) => d.path.includes("/v2_bad/"))?.status,
      "rejected",
    );
    assert.equal(
      first.documents.find((d) => d.path.includes("/v10/"))?.status,
      "current",
    );
    assert.ok(
      first.documents.findIndex((d) => d.version === "v10") <
        first.documents.findIndex((d) => d.version === "v9"),
    );
    const target = first.documents.find((d) =>
      d.path.endsWith("v10/resume.html"),
    )!;
    await writeFile(path.join(root, target.path), "<p>External edit</p>");
    const changed = (await importRepository(root)).documents.find(
      (d) => d.path === target.path,
    )!;
    assert.equal(target.logicalId, changed.logicalId);
    assert.notEqual(target.id, changed.id);
    assert.notEqual(target.hash, changed.hash);
  }));

test("partial imports report validity and access failures cannot infer closure", async () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, "company_careers/companies.md"),
      "incomplete external editor save",
    );
    const statePath = path.join(root, "company_careers/scan_state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.company_results[0].result = "FAILED";
    await writeFile(statePath, JSON.stringify(state));
    const imported = await importRepository(root);
    assert.equal(imported.validSections.companies, false);
    assert.equal(imported.validSections.openings, true);
    assert.equal(imported.openings[0].postingStatus, "not confirmed open");
    assert.equal(imported.openings[0].status, "NEW");
    assert.ok(imported.health.some((h) => h.category === "invalid-import"));
  }));

test("source disagreements expose both values and dates, never silently overwrite Markdown", async () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, "company_careers/current_openings.md"),
      opening.replace("**Technical fit:** High", "**Technical fit:** Medium"),
    );
    const imported = await importRepository(root);
    assert.equal(imported.openings[0].technical_fit, "Medium");
    const differences = (imported.openings[0].discrepancy![0] as any)
      .differences;
    assert.ok(
      differences.some(
        (d: any) =>
          d.field === "technical_fit" &&
          d.current === "Medium" &&
          d.snapshot === "High",
      ),
    );
    assert.equal(
      (imported.openings[0].discrepancy![0] as any).snapshotDate,
      "2026-09-05T12:00:00Z",
    );
  }));

test("partial scan result coverage cannot erase known failures or seen-job history", async () =>
  fixture(async (root) => {
    const file = path.join(root, "company_careers/scan_state.json"),
      state = JSON.parse(await readFile(file, "utf8"));
    state.company_results = [];
    await writeFile(file, JSON.stringify(state));
    const imported = await importRepository(root);
    assert.equal(imported.scan.stateValid, false);
    assert.ok(imported.health.some((h) => h.category === "invalid-scan-state"));
  }));

test("unsafe symlinks cannot import content outside configured root", async () =>
  fixture(async (root) => {
    const external = await mkdtemp(
      path.join(os.tmpdir(), "job-search-outside-"),
    );
    try {
      await writeFile(
        path.join(external, "resume.html"),
        "<p>Do not import external secret</p>",
      );
      await symlink(
        path.join(external, "resume.html"),
        path.join(root, "source_master_template/v10/escape.html"),
      );
      const imported = await importRepository(root);
      assert.ok(imported.health.some((h) => h.category === "unsafe-path"));
      assert.equal(
        imported.documents.some((d) => d.text.includes("external secret")),
        false,
      );
      await rm(path.join(root, "company_careers/companies.md"));
      await symlink(
        path.join(external, "resume.html"),
        path.join(root, "company_careers/companies.md"),
      );
      assert.equal(
        (await importRepository(root)).validSections.companies,
        false,
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }));

test("real checkout import counts populations from sources and retains authoritative current artifacts", async () => {
  const root = repositoryRoot;
  const imported = await importRepository(root);
  const markdown = await readFile(
    path.join(root, "company_careers/companies.md"),
    "utf8",
  );
  const state = JSON.parse(
    await readFile(path.join(root, "company_careers/scan_state.json"), "utf8"),
  );
  assert.equal(
    imported.companies.length,
    [...markdown.matchAll(/<!-- company_id:/g)].length,
  );
  assert.equal(imported.scan.seenCount, Object.keys(state.seen_jobs).length);
  assert.equal(
    imported.openings.filter((o) => o.retained !== false).length,
    parseOpenings(
      await readFile(
        path.join(root, "company_careers/current_openings.md"),
        "utf8",
      ),
    ).length,
  );
  assert.ok(
    imported.documents.some(
      (d) =>
        d.status === "current" &&
        d.scope === "general" &&
        d.format === "pdf" &&
        d.privacy === "public",
    ),
  );
  assert.ok(
    imported.documents.some(
      (d) => d.kind === "cover-letter" && d.company === "Northwind",
    ),
  );
  assert.equal(
    imported.documents.some((d) => /SIGNED|raw_evidence|\.zip$/i.test(d.path)),
    false,
  );
});

test("sample pay filtering excludes historical pay, retains published pay and preserves geographic bands", async () => {
  const snapshot = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "company_careers/research/scans/2026-09-05/qualified_openings.json",
      ),
      "utf8",
    ),
  );
  const openings = snapshot.openings.map((o: any) => ({
    ...o,
    salaryBands: salaryBands(o.compensation),
  }));
  const highPay = openings.filter((o: any) =>
    (o.salaryBands as ReturnType<typeof salaryBands>).some(
      (b) =>
        b.basis === "published base" && b.currency === "USD" && b.max >= 190000,
    ),
  );
  assert.equal(
    highPay.some((o: any) => o.company_id === "northwind"),
    false,
  );
  assert.equal(
    highPay.some((o: any) => o.company_id === "bluepine"),
    true,
  );
  const larkspur = openings.find((o: any) => o.company_id === "larkspur")!;
  assert.equal((larkspur.salaryBands as any[]).length, 2);
  assert.match((larkspur.salaryBands as any[])[0].text, /CA, CT/);
  assert.match((larkspur.salaryBands as any[])[1].text, /CO, HI/);
  assert.deepEqual(
    (larkspur.salaryBands as any[]).map((b) => [b.min, b.max, b.basis]),
    [
      [160000, 250000, "published base"],
      [150000, 240000, "published base"],
    ],
  );
});

test("a truncated yet parseable opening file cannot contradict its declared current count", () => {
  assert.throws(
    () => parseOpenings("- **Qualifying current openings:** 2\n" + opening),
    /declares 2 records but 1/,
  );
  assert.equal(
    parseOpenings("- **Qualifying current openings:** 1\n" + opening).length,
    1,
  );
});

test("Import date/privacy findings skip superseded resume versions and legacy archives", async () => {
  const paths = [
    "source_master_template/v12/resume.html",
    "source_master_template/v11/resume.html",
    "source_master_template/v2_bad/resume.pdf",
    "source_master_template/Tailspin/resume.html",
    "source_master_template/notes.md",
    "old_resume/Resume.docx",
    "employer_specific/northwind/resume_private.pdf",
    "employer_specific/acme_bad_drafts/letter.html",
    "source_data/resume.md",
  ];
  assert.deepEqual(
    paths.filter((p) => !isLegacyResumeDocument(p, "v12")),
    [
      "source_master_template/v12/resume.html",
      "source_master_template/notes.md",
      "employer_specific/northwind/resume_private.pdf",
      "source_data/resume.md",
    ],
  );
  // Without an established current version, version directories are not guessed to be legacy.
  assert.equal(
    isLegacyResumeDocument("source_master_template/v11/resume.html", null),
    false,
  );
  assert.equal(
    isLegacyResumeDocument("source_master_template/v2_bad/resume.html", null),
    true,
  );
  await fixture(async (root) => {
    const result = await importRepository(root);
    assert.ok(
      result.documents.some((d) => d.path.includes("/v9/")),
      "legacy versions are still imported",
    );
    for (const category of ["unknown-dates", "unknown-privacy"]) {
      const finding = result.health.find((h) => h.category === category);
      assert.ok(
        !finding?.paths?.some((p) => /\/(v9|v2_bad)\//.test(p)),
        `${category} omits legacy versions`,
      );
    }
  });
});
