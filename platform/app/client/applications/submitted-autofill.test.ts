import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
const { createElement, render, fireEvent, waitFor, mutationRecorder } = await import('../testing/test-render');
const { ApplicationDetail } = await import('./ApplicationDetail');
import { application, state } from '../testing/component-fixtures';
import type { Application } from '../../shared/types';

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});
const submitted: Application = { ...application, packages: [
  { id: 'pack', at: application.submittedAt!, scriptId: 'original-script', documents: [] },
] };

function setup(record = submitted, failure = false) {
  const requests: { url: string; method: string }[] = [];
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => {
      if (failure) throw new Error('Clipboard denied');
      copied.push(text);
    },
  } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/follow-up')) return Response.json({ history: [], capability: { connected: false } });
    if (url.includes('/autofill/')) return new Response(`saved bytes: ${url.split('/').at(-1)}`);
    throw new Error(`Unexpected request: ${url}`);
  };
  const { calls, mutate } = mutationRecorder();
  const view = render(createElement(ApplicationDetail, { application: record, state, mutate, go: () => {} }));
  fireEvent.click(view.getByText('Submitted documents', { selector: 'summary' }));
  return { view, requests, copied, calls };
}

test('Submitted documents re-copies its exact saved script without changing tracking or loading newer versions', async () => {
  const before = JSON.stringify(submitted);
  const { view, requests, copied, calls } = setup();
  assert.equal(requests.filter(r => r.url.includes('/autofill')).length, 0, 'script bytes load only on demand');
  fireEvent.click(view.getByRole('button', { name: 'Copy autofill script' }));
  await view.findByRole('button', { name: 'Copied' });
  assert.deepEqual(copied, ['saved bytes: original-script']);
  assert.deepEqual(requests.filter(r => r.url.includes('/autofill')), [
    { url: '/api/openings/opening-fixture/autofill/original-script', method: 'GET' },
  ]);
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(submitted), before);
});

test('clipboard failure exposes the exact script for manual selection', async () => {
  const { view, calls } = setup(submitted, true);
  fireEvent.click(view.getByRole('button', { name: 'Copy autofill script' }));
  const box = await view.findByLabelText('Autofill script to copy') as HTMLTextAreaElement;
  assert.equal(box.value, 'saved bytes: original-script');
  assert.equal(box.readOnly, true);
  assert.match(view.getByRole('alert').textContent!, /Clipboard access failed/);
  fireEvent.focus(box);
  assert.equal(box.selectionEnd, box.value.length);
  assert.deepEqual(calls, []);
});

test('missing saved script reports the server error and allows retry without copying another version', async () => {
  const { view, copied } = setup();
  globalThis.fetch = async () => Response.json({ error: 'Saved autofill script not found' }, { status: 404 });
  fireEvent.click(view.getByRole('button', { name: 'Copy autofill script' }));
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Saved autofill script not found/));
  assert.deepEqual(copied, []);
  assert.equal(view.queryByLabelText('Autofill script to copy'), null);
  globalThis.fetch = async () => new Response('restored original bytes');
  fireEvent.click(view.getByRole('button', { name: 'Copy autofill script' }));
  await view.findByRole('button', { name: 'Copied' });
  assert.deepEqual(copied, ['restored original bytes']);
});

test('each submitted package keeps its own script and legacy packages do not guess a version', async () => {
  const { view, copied } = setup({ ...submitted, packages: [...submitted.packages!,
    { id: 'second', at: application.submittedAt!, scriptId: 'second-script', documents: [] },
  ] });
  fireEvent.click(view.getAllByRole('button', { name: 'Copy autofill script' })[1]);
  await view.findByRole('button', { name: 'Copied' });
  assert.deepEqual(copied, ['saved bytes: second-script']);
  view.unmount();
  const legacy = setup(application);
  assert.equal(legacy.view.queryByRole('button', { name: 'Copy autofill script' }), null);
  assert.ok(legacy.view.getByText('No autofill script was saved with this submission.'));
});
