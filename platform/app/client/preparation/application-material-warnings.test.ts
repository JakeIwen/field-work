import assert from 'node:assert/strict';
import test from 'node:test';
// test-render registers the CSS loader that ErrorNotice's stylesheet import needs.
await import('../testing/test-render');
const { applicationMaterialWarnings, sentMaterial } = await import('./application-material-warnings');
import type { ApplicationPreparation } from '../../shared/application-preparation';

const stoppedAtForm = (error: string) =>
  ({ status: 'failed', phase: 'form', error, documentIds: [] }) as unknown as ApplicationPreparation;

test('a stopped inspection offers Generate Docs unless the posting is gone', () => {
  assert.deepEqual(
    applicationMaterialWarnings(stoppedAtForm('Acme · Engineer: Greenhouse returned HTTP 500. The form could not be verified; your saved scripts are unchanged.')),
    [
      'Application form inspection stopped.',
      'Greenhouse returned HTTP 500. The form could not be verified; your saved scripts are unchanged.',
      'Use Generate Docs to continue from saved work.',
    ],
  );
  const gone = 'Greenhouse no longer has this posting (HTTP 404), so it looks closed. Validate openings on the Openings page confirms closures and hides them; your saved scripts are unchanged.';
  assert.deepEqual(
    applicationMaterialWarnings(stoppedAtForm(`Acme · Engineer: ${gone}`)),
    ['Application form inspection stopped.', gone],
  );
});

test('a submitted application shows no out-of-date warnings, but a stopped run still shows', () => {
  const stale = { status: 'ready', phase: 'ready', documentIds: ['resume'], stale: true,
    staleReasons: ['Resume writing rules changed. Generate a new resume.'] } as ApplicationPreparation;
  assert.deepEqual(applicationMaterialWarnings(sentMaterial(stale, false))[0], 'Saved materials need updating.');
  assert.deepEqual(applicationMaterialWarnings(sentMaterial(stale, true)), []);
  assert.equal(stale.stale, true);
  const stopped = { ...stoppedAtForm('Greenhouse returned HTTP 500.'), stale: true, staleReasons: ['Opening details changed.'] };
  assert.deepEqual(applicationMaterialWarnings(sentMaterial(stopped, true)),
    ['Application form inspection stopped.', 'Greenhouse returned HTTP 500.', 'Use Generate Docs to continue from saved work.']);
});

test('a stopped resume-only run reports its resume as saved, not as an incomplete pair', () => {
  const stopped = (documentKinds?: ApplicationPreparation['documentKinds'], documentIds = ['resume']) =>
    ({ ...stoppedAtForm('Greenhouse returned HTTP 500.'), phase: 'answers', documentIds, documentKinds }) as unknown as ApplicationPreparation;
  assert.equal(applicationMaterialWarnings(stopped(['resume']))[1], 'The resume PDF is saved.');
  assert.equal(applicationMaterialWarnings(stopped(undefined))[1], 'One PDF is saved; document preparation is incomplete.');
  assert.equal(applicationMaterialWarnings(stopped(undefined, ['resume', 'letter']))[1], 'Resume and cover letter PDFs are saved.');
});
