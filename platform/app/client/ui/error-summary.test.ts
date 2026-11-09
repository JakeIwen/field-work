import test from 'node:test';
import assert from 'node:assert/strict';
await import('../testing/test-render');
const { errorSummary } = await import('./ErrorNotice');

const crash = 'Command failed: swift /Users/x/render_resume.swift\nrender_resume.swift:104: Fatal error: Page 2 overflowed by 1.120000000000232 points\nStack dump:\n0. swift-frontend';

test('a stopped overflow says how far over the page was and that shortening already ran', () => {
  assert.equal(
    errorSummary(`${crash}\n\nAutomatic shortening stopped after 2 attempts for resume. Page 2 overflowed by 1.12 points.`),
    'The resume PDF could not be generated: page 2 was still too long by 1.12 points after 2 automatic shortening attempts.',
  );
  assert.equal(errorSummary(crash), 'The resume PDF could not be generated because page 2 is too long by 1.12 points.');
  assert.equal(errorSummary('Fatal error: Page 1 overflowed'), 'The resume PDF could not be generated because page 1 is too long.');
});
