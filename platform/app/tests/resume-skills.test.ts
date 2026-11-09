import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  currentResumePath,
  evidenceDossierPath,
} from "../server/application-evidence.js";
import { resumeSkills } from "../server/resume-skills.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

function resumeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-resume-skills-"));
  const file = path.join(root, currentResumePath);
  mkdirSync(path.dirname(file), { recursive: true });
  return { root, file };
}

test("resume skills reuse unchanged evidence and refresh on either mtime or size", () => {
  const fixture = resumeFixture();
  const stamp = new Date("2026-10-20T12:00:00Z");
  const write = (text: string, date = stamp) => {
    writeFileSync(fixture.file, text);
    utimesSync(fixture.file, date, date);
  };
  try {
    assert.deepEqual(resumeSkills(fixture), []);
    write("Java");
    assert.deepEqual(resumeSkills(fixture), ["Java"]);
    const result = resumeSkills(fixture);
    result.push("Python");
    assert.deepEqual(resumeSkills(fixture), ["Java"]);
    write("Ruby");
    assert.deepEqual(
      resumeSkills(fixture),
      ["Java"],
      "unchanged mtime and size reuse the parsed result",
    );
    write("Ruby", new Date(stamp.getTime() + 1000));
    assert.deepEqual(resumeSkills(fixture), ["Ruby"]);
    write("Python", new Date(stamp.getTime() + 1000));
    assert.deepEqual(
      resumeSkills(fixture),
      ["Python"],
      "size also invalidates the cache",
    );
    unlinkSync(fixture.file);
    assert.deepEqual(resumeSkills(fixture), []);
    mkdirSync(fixture.file);
    assert.deepEqual(
      resumeSkills(fixture),
      [],
      "a non-readable document never breaks the state response",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("state returns current resume matches, not posting skills, and tolerates missing evidence", async () => {
  const fixture = resumeFixture();
  const workspace = await openFixtureWorkspace(fixture.root);
  try {
    const state = async () => {
      const response = await workspace.get("/api/state");
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual((await state()).knownSkills, []);
    writeFileSync(
      fixture.file,
      "# Skills\nReact, Node.js.\n# Experience\nValidated sample imports and used SQLite.",
    );
    assert.deepEqual((await state()).knownSkills, [
      "Node.js",
      "React",
      "SQLite",
    ]);
    writeFileSync(fixture.file, "# Current resume\nPython and AWS");
    assert.deepEqual((await state()).knownSkills, ["AWS", "Python"]);
    unlinkSync(fixture.file);
    assert.deepEqual((await state()).knownSkills, []);
  } finally {
    await workspace.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the dossier's additional known skills line joins the resume skills, and nothing else in the dossier does", () => {
  const fixture = resumeFixture();
  const dossier = path.join(fixture.root, evidenceDossierPath);
  try {
    writeFileSync(fixture.file, "React and Linux administration");
    writeFileSync(
      dossier,
      [
        "## Notes: PostgreSQL and Terraform are not confirmed skills",
        "**Additional known skills:** CSS, HTML, Rust, Redis, Linux",
        "- Ubuntu evidence notes mention Docker.",
      ].join("\n"),
    );
    assert.deepEqual(resumeSkills(fixture), [
      "CSS",
      "HTML",
      "Linux",
      "React",
      "Redis",
      "Rust",
    ]);
    unlinkSync(fixture.file);
    assert.ok(
      resumeSkills(fixture).includes("CSS"),
      "either source still counts when the other is missing",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
