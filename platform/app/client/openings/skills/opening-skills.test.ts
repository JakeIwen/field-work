import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { createElement, render, renderToStaticMarkup, cleanup, dom, fireEvent, waitFor, mutationRecorder } = await import("../../testing/test-render");
const { useState } = await import("react");
const { OpeningSkillsFilter } = await import("./OpeningSkillsFilter");
const { OpeningSkillChips } = await import("./OpeningSkillChips");
import { openingSortStorageKey, sortOpenings } from "../opening-sort";
import { openingSkillMatch } from "./opening-skill-match";
const { Openings } = await import("../../pages/Openings");
import { emptySkillFilter, matchesSkillFilter, normalizeSkillFilter, toggleSkill } from "./opening-skill-filter";
import type { SkillFilter } from "./opening-skill-filter";
import type { SavedFilter } from "../../../shared/task-records";
import type { Opening } from "../../../shared/types";
import { opening, state } from "../../testing/component-fixtures";

afterEach(() => localStorage.clear());

function skillOpening(id: string, requirements: string): Opening {
  return { ...opening, id, title: `Role ${id}`, requirements, hash: `hash-${id}`,
    url: `https://job-boards.greenhouse.io/example/jobs/${100 + id.length}` };
}

const openings = [
  skillOpening("both", "JavaScript / JS / java script; AWS"),
  skillOpening("js", "JavaScript"),
  skillOpening("ruby", "Ruby"),
  skillOpening("unknown", "Experience collaborating with colleagues"),
];

function FilterHarness({ initial = emptySkillFilter }: { initial?: SkillFilter }) {
  const [value, onChange] = useState(initial);
  return createElement(OpeningSkillsFilter, { openings, value, onChange });
}

function renderOpenings() {
  const recorded = mutationRecorder();
  const counts: number[] = [];
  const appState = { ...state, openings, applications: [], tasks: [], personal: {}, savedFilters: [] };
  const props = { state: appState, selected: "", go: () => {}, personal: async () => ({}),
    mutate: recorded.mutate, onVisibleCountChange: (count: number) => counts.push(count) };
  const view = render(createElement(Openings, props));
  const visible = () => [...view.container.querySelectorAll("tr[data-opening-id]")].map(row => row.getAttribute("data-opening-id")).sort();
  return { ...recorded, view, props, counts, visible };
}

test("skill matching supports Any, All, exclusion precedence, and exclusion without inclusion", () => {
  const any: SkillFilter = { include: ["JS", "AWS"], exclude: [], match: "any" };
  for (const skills of [["JS"], ["AWS"], ["JS", "AWS"]]) assert.equal(matchesSkillFilter(skills, any), true);
  for (const skills of [[], ["Ruby"]]) assert.equal(matchesSkillFilter(skills, any), false);
  assert.equal(matchesSkillFilter(["JS"], { ...any, match: "all" }), false);
  assert.equal(matchesSkillFilter(["JS", "AWS"], { ...any, match: "all" }), true);
  assert.equal(matchesSkillFilter(["JS", "AWS"], { ...any, exclude: ["AWS"] }), false);
  assert.equal(matchesSkillFilter(["JS"], { ...any, exclude: ["AWS"] }), true);
  const without: SkillFilter = { include: [], exclude: ["AWS", "Ruby"], match: "all" };
  assert.equal(matchesSkillFilter([], without), true);
  assert.equal(matchesSkillFilter(["JS"], without), true);
  assert.equal(matchesSkillFilter(["Ruby"], without), false);
  assert.equal(matchesSkillFilter(["AWS"], without), false);
});

test("saved skill filters normalize malformed values and let exclusions win", () => {
  assert.deepEqual(normalizeSkillFilter(undefined), emptySkillFilter);
  assert.deepEqual(normalizeSkillFilter({ include: "JS", exclude: [null, "", " "], match: "invalid" }), emptySkillFilter);
  assert.deepEqual(normalizeSkillFilter({ include: ["JS", "JS", null, "Ruby"], exclude: ["Ruby", "Ruby"], match: "all" }),
    { include: ["JS"], exclude: ["Ruby"], match: "all" });
});

test("moving a skill between Include and Exclude keeps one clause without mutating the input", () => {
  const included: SkillFilter = { include: ["JS"], exclude: ["Ruby"], match: "all" };
  const excluded = toggleSkill(included, "JS", "exclude");
  assert.deepEqual(included, { include: ["JS"], exclude: ["Ruby"], match: "all" });
  assert.deepEqual(excluded, { include: [], exclude: ["Ruby", "JS"], match: "all" });
  assert.deepEqual(toggleSkill(excluded, "JS", "include"), included);
  assert.deepEqual(toggleSkill(excluded, "JS", "exclude"), { include: [], exclude: ["Ruby"], match: "all" });
});

test("skill picker searches aliases, changes selection modes, and supports Shift-click and clear", () => {
  const view = render(createElement(FilterHarness));
  fireEvent.click(view.getByRole("button", { name: "Skills" }));
  const search = view.getByRole("searchbox", { name: "Find a skill" });
  assert.equal(document.activeElement, search);
  for (const alias of ["JavaScript", "java script", "js"]) {
    fireEvent.change(search, { target: { value: alias } });
    assert.ok(view.getByRole("button", { name: "JS, 2 openings" }));
    assert.equal(view.queryByRole("button", { name: "Ruby, 1 openings" }), null);
  }
  fireEvent.click(view.getByRole("button", { name: "JS, 2 openings" }));
  assert.ok(view.getByRole("button", { name: "Remove included JS" }));
  fireEvent.click(view.getByRole("button", { name: "Exclude" }));
  fireEvent.click(view.getByRole("button", { name: "JS, included, 2 openings" }));
  assert.equal(view.queryByRole("button", { name: "Remove included JS" }), null);
  assert.ok(view.getByRole("button", { name: "Remove excluded JS" }));
  fireEvent.click(view.getByRole("button", { name: "Include" }));
  fireEvent.change(search, { target: { value: "ruby" } });
  fireEvent.click(view.getByRole("button", { name: "Ruby, 1 openings" }), { shiftKey: true });
  assert.ok(view.getByRole("button", { name: "Remove excluded Ruby" }));
  fireEvent.change(view.getByRole("combobox", { name: "Match included skills" }), { target: { value: "all" } });
  fireEvent.click(view.getByRole("button", { name: "Clear skills" }));
  assert.equal(view.queryByRole("button", { name: /Remove (included|excluded)/ }), null);
  assert.equal((view.getByRole("combobox", { name: "Match included skills" }) as HTMLSelectElement).value, "any");
});

test("skill picker closes on Escape and outside click without losing selected skills", () => {
  const view = render(createElement(FilterHarness));
  const trigger = view.getByRole("button", { name: "Skills" });
  fireEvent.click(trigger);
  fireEvent.click(view.getByRole("button", { name: "Ruby, 1 openings" }));
  fireEvent.keyDown(view.getByRole("searchbox", { name: "Find a skill" }), { key: "Escape" });
  assert.equal(view.queryByRole("dialog", { name: "Filter by skills" }), null);
  assert.equal(document.activeElement, trigger);
  assert.ok(view.getByRole("button", { name: "Remove included Ruby" }));
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  assert.equal(view.queryByRole("dialog", { name: "Filter by skills" }), null);
});

test("Escape dismisses skill help first, then closes the picker and restores focus", () => {
  const view = render(createElement(FilterHarness));
  const trigger = view.getByRole("button", { name: "Skills" });
  fireEvent.click(trigger);
  const search = view.getByRole("searchbox", { name: "Find a skill" });
  fireEvent.mouseEnter(view.getByRole("button", { name: "How to filter by skills" }));
  assert.ok(view.getByRole("tooltip"));
  assert.equal(document.activeElement, search);
  fireEvent.keyDown(search, { key: "Escape" });
  assert.equal(view.queryByRole("tooltip"), null);
  assert.ok(view.getByRole("dialog", { name: "Filter by skills" }));
  assert.equal(document.activeElement, search);
  fireEvent.keyDown(search, { key: "Escape" });
  assert.equal(view.queryByRole("dialog", { name: "Filter by skills" }), null);
  assert.equal(document.activeElement, trigger);
});

test("skill picker keeps selected skills removable when other filters leave them with zero matches", () => {
  const value: SkillFilter = { include: ["JS"], exclude: ["Ruby"], match: "all" };
  const changes: SkillFilter[] = [];
  const view = render(createElement(OpeningSkillsFilter, { openings: [], value, onChange: next => changes.push(next) }));
  fireEvent.click(view.getByRole("button", { name: "Skills 2" }));
  assert.ok(view.getByRole("button", { name: "JS, included, 0 openings" }));
  assert.ok(view.getByRole("button", { name: "Ruby, excluded, 0 openings" }));
  fireEvent.click(view.getByRole("button", { name: "Remove included JS" }));
  assert.deepEqual(changes, [{ include: [], exclude: ["Ruby"], match: "all" }]);
});

test("skill facet counts follow other Opening filters without changing the filter clauses", () => {
  const { view, visible } = renderOpenings();
  fireEvent.change(view.getByPlaceholderText("Search company, role, or technology…"), { target: { value: "Role js" } });
  assert.deepEqual(visible(), ["js"]);
  fireEvent.click(view.getByRole("button", { name: "Skills" }));
  assert.ok(view.getByRole("button", { name: "JS, 1 openings" }));
  assert.equal(view.queryByRole("button", { name: /AWS.*openings/ }), null);
  fireEvent.click(view.getByRole("button", { name: "JS, 1 openings" }));
  fireEvent.change(view.getByPlaceholderText("Search company, role, or technology…"), { target: { value: "Role ruby" } });
  assert.deepEqual(visible(), []);
  assert.ok(view.getByRole("button", { name: "JS, included, 0 openings" }));
  assert.ok(view.getByRole("button", { name: "Ruby, 1 openings" }));
  fireEvent.click(view.getByRole("button", { name: "Clear skills" }));
  assert.deepEqual(visible(), ["ruby"]);
});

test("Openings filters rows with skill clauses, keeps facet counts stable, and resets the view", () => {
  const { view, visible, counts } = renderOpenings();
  assert.deepEqual(visible(), ["both", "js", "ruby", "unknown"]);
  assert.ok(view.getByRole("columnheader", { name: /^Skills/ }));
  assert.equal(view.queryByRole("columnheader", { name: "Published compensation" }), null);
  fireEvent.click(view.getByRole("button", { name: "Skills" }));
  fireEvent.click(view.getByRole("button", { name: "JS, 2 openings" }));
  assert.deepEqual(visible(), ["both", "js"]);
  assert.ok(view.getByRole("button", { name: "Ruby, 1 openings" }));
  fireEvent.click(view.getByRole("button", { name: "AWS, 1 openings" }));
  fireEvent.change(view.getByRole("combobox", { name: "Match included skills" }), { target: { value: "all" } });
  assert.deepEqual(visible(), ["both"]);
  fireEvent.click(view.getByRole("button", { name: "AWS, included, 1 openings" }), { shiftKey: true });
  assert.deepEqual(visible(), ["js"]);
  fireEvent.click(view.getByRole("button", { name: "Remove included JS" }));
  assert.deepEqual(visible(), ["js", "ruby", "unknown"]);
  fireEvent.click(view.getByRole("button", { name: "Close skills filter" }));
  fireEvent.click(view.getByText("More filters", { selector: "summary" }));
  fireEvent.click(view.getByRole("button", { name: "Reset" }));
  assert.deepEqual(visible(), ["both", "js", "ruby", "unknown"]);
  assert.equal(counts.at(-1), 4);
  assert.equal(view.queryByRole("button", { name: "Clear skills" }), null);
});

test("Openings saves and reloads skill clauses and accepts older saved filters without skills", async () => {
  const { view, calls, props, visible } = renderOpenings();
  fireEvent.click(view.getByRole("button", { name: "Skills" }));
  fireEvent.click(view.getByRole("button", { name: "JS, 2 openings" }));
  fireEvent.click(view.getByRole("button", { name: "AWS, 1 openings" }), { shiftKey: true });
  fireEvent.change(view.getByRole("combobox", { name: "Match included skills" }), { target: { value: "all" } });
  fireEvent.click(view.getByRole("button", { name: "Close skills filter" }));
  fireEvent.click(view.getByRole("button", { name: "Save filter" }));
  fireEvent.change(view.getByRole("textbox", { name: "Filter name" }), { target: { value: "JS without AWS" } });
  fireEvent.submit(view.getByRole("textbox", { name: "Filter name" }).closest("form")!);
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].path, "/api/filters");
  const body = calls[0].body as { name: string; filters: SavedFilter["filters"] };
  assert.deepEqual(body.filters.skills, { include: ["JS"], exclude: ["AWS"], match: "all" });
  view.rerender(createElement(Openings, { ...props, state: { ...props.state, savedFilters: [
    { id: "skills", version: 1, name: body.name, filters: body.filters },
    { id: "old", version: 1, name: "Legacy", filters: {} },
  ] } }));
  fireEvent.click(view.getByRole("button", { name: "Clear skills" }));
  assert.equal(visible().length, 4);
  fireEvent.change(view.getByRole("combobox", { name: "Load saved filter" }), { target: { value: "skills" } });
  assert.deepEqual(visible(), ["js"]);
  assert.ok(view.getByRole("button", { name: "Remove included JS" }));
  assert.ok(view.getByRole("button", { name: "Remove excluded AWS" }));
  fireEvent.change(view.getByRole("combobox", { name: "Load saved filter" }), { target: { value: "old" } });
  assert.equal(visible().length, 4);
  assert.equal(view.queryByRole("button", { name: "Clear skills" }), null);
});

const { mutate, calls } = mutationRecorder();
const personal = async () => ({});
const go = () => {};

test('skill chips expose resume matches and preserve included styling without visible explanations', () => {
  const html = renderToStaticMarkup(createElement(OpeningSkillChips, {
    opening: { ...opening, requirements: 'Python, Java, React, AWS' },
    knownSkills: ['React', 'Python'], filter: { ...emptySkillFilter, include: ['Python'] },
  }));
  const container = dom.window.document.createElement('div');
  container.innerHTML = html;
  const list = container.querySelector('[role=group]')!;
  assert.equal(list.getAttribute('aria-label'), '2 of 4 skills on your resume');
  assert.equal(list.getAttribute('title'), '2 of 4 skills on your resume');
  const chips = [...list.querySelectorAll(':scope > .skill-chip')];
  assert.deepEqual(chips.map(c => c.textContent), ['Python', 'React', 'AWS', 'Java']);
  assert.equal(chips[0].getAttribute('title'), 'On your resume');
  assert.ok(chips[0].classList.contains('skill-known'));
  assert.ok(chips[0].classList.contains('skill-included'));
  assert.equal(chips[2].getAttribute('title'), null);
  assert.equal(list.querySelector('.skill-chip-measure')?.getAttribute('aria-hidden'), 'true');
});

test('skill matches count required skills only and retain legacy posting matches', () => {
  const known = new Set(['AWS', 'JS', 'React']);
  const classified = { ...skillOpening('classified', 'React, Java, Rust, AWS, JS, Docker'),
    skills: { required: ['React', 'Java', 'Rust'], preferred: ['AWS', 'JS', 'Docker'] }, skillsSourceHash: 'hash-classified' };
  assert.deepEqual(openingSkillMatch(classified, known), { matched: 1, total: 3, fraction: 1 / 3 });
  assert.deepEqual(openingSkillMatch({ ...classified, skills: { required: [], preferred: ['React', 'AWS'] } }, known),
    { matched: 0, total: 0, fraction: 0 });
  assert.deepEqual(openingSkillMatch(skillOpening('legacy', 'React, Java, Rust, AWS, JS, Docker'), known),
    { matched: 3, total: 6, fraction: .5 });
});

test('any-of requirements count once and are met by any known member', () => {
  const grouped = { ...skillOpening('grouped', ''), skillsSourceHash: 'hash-grouped',
    skills: { required: ['React', 'AWS'], anyOf: [['Go', 'Python'], ['Java', 'Rust']], preferred: ['JS'] } };
  assert.deepEqual(openingSkillMatch(grouped, new Set(['React', 'Python', 'JS'])),
    { matched: 2, total: 4, fraction: .5 });
  assert.deepEqual(openingSkillMatch(grouped, new Set(['Go', 'Python', 'Java', 'Rust'])),
    { matched: 2, total: 4, fraction: .5 });
  assert.deepEqual(openingSkillMatch(grouped, new Set(['React', 'JS'])),
    { matched: 1, total: 4, fraction: .25 });
  assert.deepEqual(openingSkillMatch({ ...grouped, skills: { required: [], anyOf: [['Go', 'Python']], preferred: [] } }, new Set(['Python'])),
    { matched: 1, total: 1, fraction: 1 });
});

test('Skills percent and count sorts count satisfied groups, not their individual members', () => {
  const grouped = { ...skillOpening('grouped', ''),
    skills: { required: ['React', 'Java'], anyOf: [['Go', 'JS'], ['Python', 'Rust']], preferred: ['AWS', 'Docker'] } };
  const list = [skillOpening('none', ''), skillOpening('half', 'React, JS, Java, Docker'), grouped,
    skillOpening('full', 'React'), skillOpening('many', 'AWS, JS, React, Java, Docker, Rust, Python')];
  const ordered = (sort: string) => sortOpenings(list, sort, {}, {}, ['AWS', 'JS', 'React']).map(item => item.id);
  assert.deepEqual(ordered('skills-percent'), ['full', 'grouped', 'half', 'many', 'none']);
  assert.deepEqual(ordered('skills-count'), ['many', 'grouped', 'half', 'full', 'none']);
});

test('Skills percent and count sorts ignore nice-to-have matches in a mixed list', () => {
  const classified = { ...skillOpening('classified', 'React, Java, Rust, AWS, JS, Docker'),
    skills: { required: ['React', 'Java', 'Rust'], preferred: ['AWS', 'JS', 'Docker'] } };
  const preferredOnly = { ...skillOpening('preferred', 'React, AWS'),
    skills: { required: [], preferred: ['React', 'AWS'] } };
  const list = [preferredOnly, classified, skillOpening('half', 'React, JS, Java, Docker'),
    skillOpening('full', 'React'), skillOpening('many', 'AWS, JS, React, Java, Docker, Rust, Python')];
  const ordered = (sort: string) => sortOpenings(list, sort, {}, {}, ['AWS', 'JS', 'React']).map(item => item.id);
  assert.deepEqual(ordered('skills-percent'), ['full', 'half', 'many', 'classified', 'preferred']);
  assert.deepEqual(ordered('skills-count'), ['many', 'half', 'full', 'classified', 'preferred']);
});

test('classified chips put required before preferred with resume matches first inside each group', () => {
  const html = renderToStaticMarkup(createElement(OpeningSkillChips, {
    opening: { ...skillOpening('classified', ''), skillsSourceHash: 'hash-classified',
      skills: { required: ['Java', 'React', 'Python', 'AWS'], preferred: ['Rust', 'JS', 'Docker', 'Angular'] } },
    knownSkills: ['React', 'Python', 'JS', 'Angular'], filter: emptySkillFilter,
  }));
  const container = dom.window.document.createElement('div');
  container.innerHTML = html;
  const list = container.querySelector('[role=group]')!;
  const summary = '2 of 4 required skills on your resume · 4 nice to have';
  assert.equal(list.getAttribute('aria-label'), summary);
  assert.equal(list.getAttribute('title'), summary);
  const chips = [...list.querySelectorAll(':scope > .skill-chip')];
  const names = ['Python', 'React', 'AWS', 'Java', 'Angular', 'JS', 'Docker', 'Rust'];
  assert.deepEqual(chips.map(chip => chip.textContent), names);
  assert.deepEqual(chips.map(chip => chip.classList.contains('skill-preferred')), [false, false, false, false, true, true, true, true]);
  assert.deepEqual(chips.map(chip => chip.classList.contains('skill-known')), [true, true, false, false, true, true, false, false]);
  assert.equal(chips[4].getAttribute('title'), 'Nice to have · on your resume');
  assert.equal(chips[6].getAttribute('title'), 'Nice to have');
  assert.deepEqual([...list.querySelectorAll('.skill-chip-measure > .skill-chip')].map(chip => chip.textContent), [...names, '…']);
});

test('group chips mix with required singles, known first, and share measured labels', () => {
  const html = renderToStaticMarkup(createElement(OpeningSkillChips, {
    opening: { ...skillOpening('grouped', ''), skillsSourceHash: 'hash-grouped',
      skills: { required: ['React', 'AWS'], anyOf: [['Go', 'Python'], ['Java', 'Rust']], preferred: ['Docker', 'TS'] } },
    knownSkills: ['React', 'Python', 'Docker'], filter: { ...emptySkillFilter, include: ['Go', 'Java'] },
  }));
  const container = dom.window.document.createElement('div');
  container.innerHTML = html;
  const list = container.querySelector('[role=group]')!;
  const chips = [...list.querySelectorAll(':scope > .skill-chip')];
  assert.deepEqual(chips.map(chip => chip.textContent), ['Go / Python', 'React', 'AWS', 'Java / Rust', 'Docker', 'TS']);
  assert.equal(list.getAttribute('title'), '2 of 4 required skills on your resume · 2 nice to have');
  assert.equal(list.getAttribute('aria-label'), list.getAttribute('title'));
  assert.equal(chips[0].getAttribute('title'), 'Any one of these · on your resume');
  assert.equal(chips[3].getAttribute('title'), 'Any one of these');
  assert.deepEqual(chips.map(chip => chip.classList.contains('skill-group')), [true, false, false, true, false, false]);
  assert.deepEqual(chips.map(chip => chip.classList.contains('skill-known')), [true, true, false, false, true, false]);
  assert.deepEqual(chips.map(chip => chip.classList.contains('skill-included')), [true, false, false, true, false, false]);
  assert.deepEqual(chips.map(chip => chip.classList.contains('skill-preferred')), [false, false, false, false, true, true]);
  assert.equal(chips[0].querySelector('.skill-or')?.textContent, '/');
  const measured = [...list.querySelectorAll('.skill-chip-measure > .skill-chip')];
  assert.deepEqual(measured.map(chip => chip.textContent), [...chips.map(chip => chip.textContent), '…']);
  assert.deepEqual(measured.slice(0, -1).map(chip => chip.innerHTML), chips.map(chip => chip.innerHTML));
  assert.equal(list.querySelectorAll('.skill-chip-measure > .skill-group').length, 2);
});

test('classified chips without preferred skills retain the legacy match summary', () => {
  const view = render(createElement(OpeningSkillChips, {
    opening: { ...skillOpening('required', ''), skills: { required: ['React', 'Java'], preferred: [] } },
    knownSkills: ['React'], filter: emptySkillFilter,
  }));
  const list = view.getByRole('group', { name: '1 of 2 skills on your resume' });
  assert.equal(list.getAttribute('title'), '1 of 2 skills on your resume');
  assert.equal(list.querySelector('.skill-preferred'), null);
});

test('groups without preferred skills use the unchanged skill summary', () => {
  const view = render(createElement(OpeningSkillChips, {
    opening: { ...skillOpening('grouped', ''), skills: { required: ['React'], anyOf: [['Go', 'Python']], preferred: [] } },
    knownSkills: ['React', 'Python'], filter: emptySkillFilter,
  }));
  assert.equal(view.getByRole('group').getAttribute('title'), '2 of 2 skills on your resume');
  assert.equal(view.getByRole('group').getAttribute('aria-label'), '2 of 2 skills on your resume');
});

test('overflow disclosure labels groups and preferred skills as separate requirements', () => {
  const view = render(createElement(OpeningSkillChips, {
    opening: { ...skillOpening('hidden', ''),
      skills: { required: ['React'], anyOf: [['Go', 'Python'], ['Java', 'Rust']], preferred: ['Docker'] } },
    knownSkills: ['React', 'Python'], filter: emptySkillFilter,
  }));
  const overflow = view.container.querySelector('.skill-overflow')!;
  assert.equal(overflow.getAttribute('title'), 'More skills: Go / Python (any one), React, Java / Rust (any one), Docker (nice to have)');
  assert.equal(overflow.getAttribute('aria-label'), overflow.getAttribute('title'));
  assert.equal(view.getByRole('group').getAttribute('aria-label'), '2 of 3 required skills on your resume · 1 nice to have');
});

test('overflow disclosure labels preferred skills without counting them as required', () => {
  const view = render(createElement(OpeningSkillChips, {
    opening: { ...skillOpening('hidden', ''), skills: { required: ['React'], preferred: ['Go', 'AWS'] } },
    knownSkills: ['React', 'AWS'], filter: emptySkillFilter,
  }));
  const overflow = view.container.querySelector('.skill-overflow')!;
  assert.equal(overflow.getAttribute('title'), 'More skills: React, AWS (nice to have), Go (nice to have)');
  assert.equal(overflow.getAttribute('aria-label'), overflow.getAttribute('title'));
  assert.equal(view.getByRole('group').getAttribute('aria-label'), '1 of 1 required skills on your resume · 2 nice to have');
});

test('Skills header cycles descending match sorts and retired saved sorts fall back without writes', () => {
  const previous = localStorage.getItem(openingSortStorageKey);
  localStorage.setItem(openingSortStorageKey, 'deadline-desc');
  calls.length = 0;
  try {
    const view = render(createElement(Openings, { state: { ...state, applications: [], knownSkills: ['React'], savedFilters: [{ id: 'old', name: 'Old deadline filter', filters: { sort: 'deadline' }, version: 1 }] }, selected: '', go, personal, mutate }));
    const select = view.getByLabelText('Sort opportunities') as HTMLSelectElement;
    assert.equal(select.value, 'docs-first');
    assert.equal(view.queryByRole('columnheader', { name: /Deadline/ }), null);
    const header = view.getByRole('button', { name: 'Skills. Sort next by % match' });
    assert.equal(header.getAttribute('title'), 'Cycle sorting: % of required posting skills on your resume → number matched. Each any-of group counts once and is met by any member. Nice-to-have skills are dimmed and not counted. Openings with no recognized required skills stay last.');
    fireEvent.click(header);
    assert.equal(select.value, 'skills-percent');
    assert.equal(view.getByRole('columnheader', { name: /^Skills/ }).getAttribute('aria-sort'), 'descending');
    fireEvent.click(view.getByRole('button', { name: /Skills\. Sorted by % match/ }));
    assert.equal(select.value, 'skills-count');
    fireEvent.click(view.getByRole('button', { name: /Skills\. Sorted by # matched/ }));
    assert.equal(select.value, 'skills-percent');
    fireEvent.change(view.getByLabelText('Load saved filter'), { target: { value: 'old' } });
    assert.equal(select.value, 'docs-first');
    assert.equal(localStorage.getItem(openingSortStorageKey), 'docs-first');
    assert.deepEqual(calls, []);
    cleanup();
  } finally {
    if (previous === null) localStorage.removeItem(openingSortStorageKey);
    else localStorage.setItem(openingSortStorageKey, previous);
  }
});
