import test from "node:test";
import assert from "node:assert/strict";
import { fitSkillChips } from "./fit-skill-chips.js";
import { knownSkillsFirst } from "./opening-skill-match.js";

test("chip fitting keeps complete lists and reserves the last row for overflow only when needed", () => {
  assert.equal(fitSkillChips([], 100, 4, 20).visible, 0);
  assert.equal(fitSkillChips([40, 40], 84, 4, 20, 1).visible, 2);
  assert.equal(fitSkillChips([40, 40, 40], 84, 4, 20, 1).visible, 1);
  assert.equal(fitSkillChips(Array(14).fill(40), 84, 4, 20).visible, 14);
  assert.equal(fitSkillChips(Array(15).fill(40), 84, 4, 20).visible, 13);
  assert.equal(fitSkillChips(Array(15).fill(40), 128, 4, 20).visible, 15);
  assert.equal(fitSkillChips([40, 40, 40], 0, 4, 20).visible, 0);
});

test("chip fitting handles fractional widths and caps individually overlong chips", () => {
  assert.equal(fitSkillChips([40.25, 40.25, 40], 84.5, 4, 20, 1).visible, 1);
  assert.equal(fitSkillChips([300, 30], 100, 4, 20, 2).visible, 2);
  assert.equal(fitSkillChips([300, 30], 100, 4, 20, 1).visible, 0);
  assert.equal(fitSkillChips([60, 30, 20], 100, 4, 12, 1).visible, 1);
});

test("known skills precede unknown skills, each group alphabetical without mutating input", () => {
  const skills = ["Python", "AWS", "React", "Java", "JS"];
  assert.deepEqual(knownSkillsFirst(skills, new Set(["React", "JS", "Bash"])), [
    "JS",
    "React",
    "AWS",
    "Java",
    "Python",
  ]);
  assert.deepEqual(knownSkillsFirst(skills, new Set()), [
    "AWS",
    "Java",
    "JS",
    "Python",
    "React",
  ]);
  assert.deepEqual(skills, ["Python", "AWS", "React", "Java", "JS"]);
});

test("a wide final skill keeps the overflow disclosure on row seven", () => {
  assert.deepEqual(
    fitSkillChips([...Array(5).fill(100), 40, 90, 30], 100, 4, 20),
    { visible: 6, overflowOnNewRow: true },
  );
  assert.deepEqual(
    fitSkillChips([...Array(5).fill(100), 40, 40, 30], 100, 4, 20),
    { visible: 8, overflowOnNewRow: false },
  );
});
