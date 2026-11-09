import test from "node:test";
import assert from "node:assert/strict";
import {
  researchBullets,
  researchParagraphs,
} from "./research-paragraphs.js";

test("long assessments get sentence-boundary paragraphs without changes to wording", () => {
  const text =
    "The supplied resume supports the five-year requirement, founder-facing independent delivery, server reliability, and AI-assisted development duties. The posting requests strong Next.js, Django and PostgreSQL experience, which is not established. React and relational database experience provide adjacent foundations, with material framework gaps to discuss. The role allows remote work, but permitted states and travel conditions need confirmation. Employer flexibility claims alone do not establish actual working hours.";
  const paragraphs = researchParagraphs(text);
  assert.ok(paragraphs.length > 1);
  assert.equal(paragraphs.join(" "), text);
  assert.ok(
    paragraphs.some((paragraph) =>
      paragraph.includes("Next.js, Django and PostgreSQL"),
    ),
  );
});

test("explicit paragraphs, lists and Markdown links stay intact", () => {
  const link =
    "[Official description. Further details](https://example.com/jobs/1?version=2.1)";
  const long = `${"This sentence establishes the supported role requirements. ".repeat(9)}See ${link} for conditions. No different position is substituted.`;
  const paragraphs = researchParagraphs(long);
  assert.equal(paragraphs.join(" "), long);
  assert.ok(paragraphs.some((paragraph) => paragraph.includes(link)));
  const list = "Requirements:\n- React and Node.js\n- SQL databases";
  assert.deepEqual(researchParagraphs(`Short summary.\n\n${list}`), [
    "Short summary.",
    list,
  ]);
  assert.deepEqual(researchParagraphs(""), []);
});

test("assessment bullets follow sentences, list items and paragraphs", () => {
  const text =
    "Medium. The supplied resume supports the backend requirement. Eight years of Node.js is not established.\n\nThe posting permits U.S. remote employment outside California. See [the posting. Section 2](https://example.com/jobs/1?v=2.1) for limits.\n\nOpen questions:\n- On-call frequency\n- Approved work states. Travel rules too.";
  assert.deepEqual(researchBullets(text), [
    [
      "The supplied resume supports the backend requirement.",
      "Eight years of Node.js is not established.",
    ],
    [
      "The posting permits U.S. remote employment outside California.",
      "See [the posting. Section 2](https://example.com/jobs/1?v=2.1) for limits.",
    ],
    [
      "Open questions:",
      "On-call frequency",
      "Approved work states. Travel rules too.",
    ],
  ]);
  assert.deepEqual(
    researchBullets("Medium. Supports the API work.\nVue 3 is new."),
    [["Supports the API work."], ["Vue 3 is new."]],
  );
  assert.deepEqual(
    researchBullets("No C# or .NET requirement. Python is documented."),
    [["No C# or .NET requirement.", "Python is documented."]],
  );
  assert.deepEqual(researchBullets("High — strong backend match."), [
    ["High — strong backend match."],
  ]);
  assert.deepEqual(researchBullets("Uncertain."), [["Uncertain."]]);
  assert.deepEqual(researchBullets(""), []);
});
