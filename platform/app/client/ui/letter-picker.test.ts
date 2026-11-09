// Run with: node --import tsx --test app/client/ui/letter-picker.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
const { createElement, render, fireEvent, waitFor, within, mutationRecorder } = await import('../testing/test-render');
const { default: LetterPicker } = await import('./LetterPicker');
const { default: CodexModels } = await import('../settings/CodexModels');
const { CodexModelCatalogProvider } = await import('../workspace/CodexModelCatalog');
import { state } from '../testing/component-fixtures';

const { mutate } = mutationRecorder();
const radios = (group: HTMLElement) => within(group).getAllByRole('radio') as HTMLButtonElement[];
const checkedLabel = (group: HTMLElement) => radios(group).find(radio => radio.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label');
const radioNamed = (group: HTMLElement, name: string) => radios(group).find(radio => radio.getAttribute('aria-label') === name)!;
const modelGroupFor = (view: ReturnType<typeof render>, name: string) => view.getByRole('radiogroup', { name });

const options = [
  { id: 'a', letter: 'A', label: 'Alpha' },
  { id: 'b', letter: 'B', label: 'Beta' },
  { id: 'c', letter: 'C', label: 'Gamma' },
];
function picker() {
  const changes: string[] = [];
  const view = render(createElement(LetterPicker, { label: 'Pick', value: 'a', options, onChange: (id: string) => changes.push(id) }));
  return { view, changes, group: view.getByRole('radiogroup', { name: 'Pick' }) };
}

test('Space on a focused unchecked tile is left to native button activation', () => {
  const { changes, group } = picker();
  const tile = radioNamed(group, 'Beta');
  tile.focus();
  const notPrevented = fireEvent.keyDown(tile, { key: ' ' });
  assert.equal(notPrevented, true, 'an unmatched key is not default-prevented');
  assert.equal(fireEvent.keyDown(tile, { key: 'Enter' }), true);
  assert.deepEqual(changes, []);
  fireEvent.click(tile);
  assert.deepEqual(changes, ['b']);
});

test('A matched letter is default-prevented and Shift+letter still selects', () => {
  const { changes, group } = picker();
  assert.equal(fireEvent.keyDown(radioNamed(group, 'Alpha'), { key: 'b' }), false);
  assert.deepEqual(changes, ['b']);
  fireEvent.keyDown(radioNamed(group, 'Alpha'), { key: 'C', shiftKey: true });
  assert.deepEqual(changes, ['b', 'c']);
});

test('Letter pickers choose by typed letter and by arrow keys, and the key explains the letters', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ models: [
    { id: 'fixture', model: 'fixture', displayName: 'Fixture model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }] },
    { id: 'other', model: 'other', displayName: 'High only', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ], error: null, refreshing: false, refreshedAt: '2026-10-06T18:00:00Z' });
  try {
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings: { ...state.settings, codexModels: {}, codexEfforts: {} } }, mutate, notify: () => {} })));
    const effort = () => modelGroupFor(view, 'Questions and follow-ups effort');
    const model = () => modelGroupFor(view, 'Questions and follow-ups');
    await waitFor(() => assert.equal(radios(effort()).length, 3));
    assert.deepEqual(radios(effort()).map(radio => radio.textContent), ['H', 'X', 'M']);
    const keys = view.container.querySelectorAll('.letter-key');
    assert.match(keys[0].textContent!, /Fixture model/);
    assert.match(keys[1].textContent!, /Extra high/);
    assert.deepEqual(radios(effort()).map(radio => radio.tabIndex), [0, -1, -1], 'only the checked tile is in the tab order');
    fireEvent.keyDown(radioNamed(effort(), 'High'), { key: 'x' });
    assert.equal(checkedLabel(effort()), 'Extra high');
    assert.equal(document.activeElement, radioNamed(effort(), 'Extra high'));
    fireEvent.keyDown(radioNamed(effort(), 'Extra high'), { key: 'ArrowRight' });
    assert.equal(checkedLabel(effort()), 'Max');
    fireEvent.keyDown(radioNamed(effort(), 'Max'), { key: 'ArrowRight' });
    assert.equal(checkedLabel(effort()), 'High', 'arrow keys wrap around');
    fireEvent.keyDown(radioNamed(effort(), 'High'), { key: 'ArrowUp' });
    assert.equal(checkedLabel(effort()), 'Max');
    fireEvent.keyDown(radioNamed(effort(), 'Max'), { key: 'q' });
    assert.equal(checkedLabel(effort()), 'Max', 'an unmatched letter changes nothing');
    fireEvent.keyDown(radioNamed(model(), 'Fixture model · Codex (recommended default)'), { key: 'h' });
    assert.equal(checkedLabel(model()), 'High only · Codex');
  } finally { globalThis.fetch = previousFetch; }
});

test('Codex settings keep a saved model the catalog no longer offers visible until another is chosen', async () => {
  const previousFetch = globalThis.fetch;
  const sol = (id: string, displayName: string, hidden: boolean) => ({ id, model: id, displayName, hidden, isDefault: id === 'gpt-6.1-sol', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] });
  globalThis.fetch = async () => Response.json({ models: [sol('gpt-6.1-sol', 'GPT-6.1-Sol', false), sol('gpt-6-sol', 'GPT-6-Sol', true)], error: null, refreshing: false, refreshedAt: '2026-10-06T18:00:00Z' });
  try {
    const settings = { ...state.settings, codexModels: { questions: 'gpt-6-sol' }, codexEfforts: {} };
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings }, mutate, notify: () => {} })));
    const model = () => modelGroupFor(view, 'Questions and follow-ups');
    await waitFor(() => assert.equal(radios(model()).length, 2));
    assert.deepEqual(radios(model()).map(radio => radio.textContent), ['S', 'Sol 6']);
    assert.equal(checkedLabel(model()), 'gpt-6-sol (unavailable)');
    assert.ok(radioNamed(model(), 'gpt-6-sol (unavailable)').classList.contains('is-unavailable'));
    fireEvent.click(radioNamed(model(), 'Sol 6.1 · Codex'));
    assert.equal(radios(model()).length, 1, 'the unavailable option disappears once another model is chosen');
    assert.equal(checkedLabel(model()), 'Sol 6.1 · Codex');
  } finally { globalThis.fetch = previousFetch; }
});
