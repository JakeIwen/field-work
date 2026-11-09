import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseRendererOverflow,
  rendererOverflowResult,
} from "../../server/renderer-overflow.js";
import { overflowLayoutGuidance } from "../../server/overflow-layout.js";
import { currentVersion } from "../../server/import/document-content.js";
import { sampleWorkspaceRoot as repositoryRoot } from "../fixtures/sample-workspace.js";

const execFileAsync = promisify(execFile);

test("trusted overflow parsing preserves measured page/points amid Swift crash diagnostics", () => {
  for (const points of [
    "1.12",
    "2.16",
    "14.35",
    "1.1200000000000045",
    "1.12e+1",
  ])
    assert.deepEqual(
      parseRendererOverflow(
        `warning\n/path/render_resume.swift:101: Fatal error: Page 2 overflowed by ${points} points\nStack dump:\n0 swift 0xabcdef`,
        "resume",
      ),
      { kind: "resume", page: 2, points: Number(points) },
    );
  assert.deepEqual(
    parseRendererOverflow(
      "Fatal error: Page 1 overflowed by .5 points",
      "cover-letter",
    ),
    { kind: "cover-letter", page: 1, points: 0.5 },
  );
});

test("unmeasured, invalid, non-renderer and non-overflow errors retain ordinary failure behavior", () => {
  for (const text of [
    "Page 2 overflowed by 1.12 points",
    "Fatal error: Page 0 overflowed by 1 points",
    "Fatal error: Page 2 overflowed by NaN points",
    "Fatal error: Page 2 overflowed by -2 points",
    "Fatal error: Page 2 overflowed by 1e999 points",
    "Fatal error: Page 2 overflowed by 0 points",
    "Letter text overflows one page at the standard layout",
    "error: compilation failed",
  ])
    assert.equal(parseRendererOverflow(text, "resume"), undefined, text);
  assert.deepEqual(
    rendererOverflowResult(
      new Error("Fatal error: Page 2 overflowed by 1.12 points"),
    ),
    {},
  );
});

const layoutReport = (report: unknown) =>
  `Layout report: ${JSON.stringify(report)}\n/path/render_resume.swift:104: Fatal error: Page 2 overflowed by 1.120000000000232 points\nStack dump:\n0 swift`;
const blocks = [
  {
    text: "Owned a production Rails insurance portal",
    lines: 4,
    lastLineChars: 10,
  },
  {
    text: "Built a musician collaboration platform",
    lines: 1,
    lastLineChars: 8,
  },
  { text: "Kept production email working", lines: 3, lastLineChars: 100 },
];

test("the renderer's layout report rides along with the measured overflow", () => {
  const overflow = parseRendererOverflow(
    layoutReport({ page: 2, lineHeight: 13.23, blocks }),
    "resume",
  );
  assert.deepEqual(overflow?.layout, { lineHeight: 13.23, blocks });
  const guidance = overflowLayoutGuidance(overflow!);
  assert.match(
    guidance,
    /each body line is 13\.23 points, so removing 1 full line/,
  );
  // A one-line block can only be deleted, so the cheapest wrapped line leads.
  assert.match(
    guidance,
    /:\n- "Owned a production Rails insurance portal": 4 lines, last line 10 characters\n- "Kept production email working"/,
  );
  assert.doesNotMatch(guidance, /musician/);
});

test("a malformed or mismatched layout report keeps the overflow without a layout", () => {
  for (const report of [
    { page: 1, lineHeight: 13.23, blocks },
    { page: 2, lineHeight: -1, blocks },
    {
      page: 2,
      lineHeight: 13.23,
      blocks: [{ text: "x", lines: 0, lastLineChars: 1 }],
    },
    { page: 2, lineHeight: 13.23, blocks: "not a list" },
  ])
    assert.deepEqual(
      parseRendererOverflow(layoutReport(report), "resume"),
      { kind: "resume", page: 2, points: 1.120000000000232 },
      JSON.stringify(report),
    );
  assert.equal(
    overflowLayoutGuidance({ kind: "resume", page: 2, points: 1 }),
    "",
  );
});

test(
  "the current master's renderer reports page-two line layout when the page overflows",
  { skip: process.platform !== "darwin", timeout: 120000 },
  async () => {
    const readme = readFileSync(
      path.join(repositoryRoot, "source_data/README.md"),
      "utf8",
    );
    const version = currentVersion(readme);
    assert.ok(version, "source_data/README.md names no current master");
    const dir = path.join(repositoryRoot, "source_master_template", version);
    const html = readdirSync(dir).find(
      (name) => name.endsWith(".html") && !name.endsWith("_public.html"),
    );
    assert.ok(html);
    const filler =
      `<li>${"Maintained a reporting service and its scheduled jobs. ".repeat(20)}</li>\n`.repeat(
        4,
      );
    const source = readFileSync(path.join(dir, html), "utf8");
    const at = source.lastIndexOf("</ul>");
    const work = mkdtempSync(path.join(tmpdir(), "overflow-layout-"));
    try {
      writeFileSync(
        path.join(work, "input.html"),
        source.slice(0, at) + filler + source.slice(at),
      );
      const failure = await execFileAsync(
        "swift",
        [
          "-module-cache-path",
          path.join(tmpdir(), "overflow-layout-swift-cache"),
          path.join(dir, "render_resume.swift"),
          path.join(work, "input.html"),
          path.join(work, "output.pdf"),
        ],
        { timeout: 110000 },
      ).then(
        () => assert.fail("the padded resume rendered without overflowing"),
        (error: { stderr?: string }) => error.stderr ?? "",
      );
      const overflow = parseRendererOverflow(failure, "resume");
      assert.equal(overflow?.page, 2, failure.slice(0, 500));
      const padded = overflow?.layout?.blocks.filter((block) =>
        block.text.startsWith("Maintained a reporting service"),
      );
      assert.equal(padded?.length, 4);
      assert.ok(
        padded!.every((block) => block.lines >= 2 && block.lastLineChars > 0),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
