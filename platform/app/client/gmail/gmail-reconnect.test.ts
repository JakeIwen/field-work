import assert from 'node:assert/strict';
import test from 'node:test';
const { createElement, render, cleanup, fireEvent } = await import('../testing/test-render');
const { default: GmailReplies } = await import('./GmailReplies');
import { state } from '../testing/component-fixtures';

const go = () => {};

test('An expired Gmail authorization offers a Reconnect Gmail button instead of directions', async () => {
  const priorFetch = globalThis.fetch;
  const gmail = { configured: true, connected: true, account: 'candidate@example.net',
    filterSettingsGranted: true, sendGranted: true, enabled: true, autoUpdate: true, includeNegative: false,
    checking: false, hasMore: false, checked: 0, needsNegativeBackfill: false, needsRescan: false, replies: [],
    error: 'Gmail authorization expired or was revoked.', reconnectRequired: true };
  const writes: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/gmail') return Response.json(gmail);
    if (String(input) === '/api/session') return Response.json({ csrfToken: 'token' });
    if (String(input) === '/api/gmail/connect') writes.push(JSON.parse(String(init?.body)));
    return Response.json({ error: 'stop before navigating' }, { status: 500 });
  };
  try {
    const view = render(createElement(GmailReplies, { state, page: 'openings', go }));
    const alert = await view.findByRole('alert');
    assert.equal(alert.textContent?.includes('Settings'), false);
    fireEvent.click(view.getByRole('button', { name: 'Reconnect Gmail' }));
    await view.findByText('stop before navigating');
    assert.deepEqual(writes, [{ returnTo: window.location.hash }]);
  } finally { cleanup(); globalThis.fetch = priorFetch; }
});
