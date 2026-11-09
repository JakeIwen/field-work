import assert from 'node:assert/strict';
import test from 'node:test';
const { createElement, renderToStaticMarkup } = await import('../testing/test-render');
const { PreparationProgress } = await import('./ApplicationPreparation');
import type { ApplicationPreparation } from '../../shared/application-preparation';

const run = (patch: Partial<ApplicationPreparation>) =>
  ({ id: 'run', openingId: 'one', status: 'running', phase: 'documents', message: 'Working', supportedForm: true, documentIds: [], taskIds: [], ...patch }) as unknown as ApplicationPreparation;
const render = (patch: Partial<ApplicationPreparation>) =>
  renderToStaticMarkup(createElement(PreparationProgress, { run: run(patch), go: () => {} }));

test('the documents row names the cover letter unless the form has no slot for one', () => {
  assert.match(render({}), /Resume \+ cover letter: in progress/);
  assert.match(render({ documentIds: ['a', 'b'] }), /Resume \+ cover letter: saved and validated/);
  const resumeOnly = render({ documentKinds: ['resume'], documentIds: ['a'] });
  assert.match(resumeOnly, /Resume: saved and validated\. This form has no cover-letter upload slot\./);
  assert.doesNotMatch(resumeOnly, /Resume \+ cover letter/);
  assert.match(render({ documentKinds: ['resume'] }), /Resume: in progress/);
});
