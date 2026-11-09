import assert from 'node:assert/strict';
import test from 'node:test';
const { createElement, render, fireEvent, waitFor, mutationRecorder } = await import('../testing/test-render');
const { ApplicationDetail } = await import('./ApplicationDetail');
const { FollowUpEmailButton } = await import('./FollowUpEmailButton');
const { setCsrf } = await import("../workspace/api");
import { application, state } from '../testing/component-fixtures';
import type { ApplicationFollowUpSummary, FollowUpDraft, FollowUpSendCapability } from '../../shared/follow-up-email';

const typed = 'Hi Zoë,\n\n“Quotes” — dash, café, 日本語, 👋🏽 👩‍💻, NBSP: x, tab:\tend   \n\nBest,\nAlex Morgan';
const draft: FollowUpDraft = {
  id: 'draft-1', to: 'dana@example.com', subject: 'Following up on my application',
  body: 'Hello,\n\nI applied last week and remain interested.\n\nBest,\nAlex Morgan', source: 'generated', at: '2026-10-15T12:00:00Z',
};
const summary = (patch: Partial<ApplicationFollowUpSummary> = {}): ApplicationFollowUpSummary => ({
  id: application.id, applicationId: application.id, openingId: application.openingId, version: 2,
  createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z', historyCount: 0,
  sent: [], testSends: [], recipientCandidates: [], ...patch,
});
const granted: FollowUpSendCapability = { connected: true, sendGranted: true, account: 'candidate@example.net' };
function server(initial: ApplicationFollowUpSummary, capability: FollowUpSendCapability = granted) {
  const requests: { url: string; method: string; body?: any }[] = [];
  let current = initial;
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (method === 'PUT') current = { ...current, version: current.version + 1, draft: { ...current.draft!, ...body, id: `draft-${current.version + 1}`, source: 'edited' } };
    else if (url.endsWith('/send')) current = { ...current, version: current.version + 1, sent: [...current.sent, {
      id: 's1', at: '2026-10-15T13:00:00Z', to: current.draft!.to, subject: current.draft!.subject, body: current.draft!.body,
      delivery: 'gmail', account: 'candidate@example.net', gmailMessageId: 'a1', gmailThreadId: 'b1', draftId: current.draft!.id,
      verification: { status: 'matched', checkedAt: '2026-10-15T13:00:01Z' } }] };
    else if (method === 'POST') current = { ...current, version: current.version + 1, generation: { kind: 'generate', status: 'drafting', startedAt: '2026-10-15T13:00:00Z', requestId: 'r' } };
    return Response.json({ followUp: current, history: [], capability });
  };
  setCsrf('fixture-token');
  return requests;
}
const { mutate } = mutationRecorder();
const go = () => {};

test('an Application opens on the follow-up section; everything else is collapsed and the unused panels are gone', async () => {
  const requests = server(summary());
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, followUps: [summary()] }, mutate, go }));
  const button = await view.findByRole('button', { name: 'Draft follow-up email' });
  const sections = [...view.container.querySelectorAll('details.application-section')] as HTMLDetailsElement[];
  assert.deepEqual(sections.map(s => s.querySelector('summary')!.textContent), ['Stage, follow-up date and notes', 'Submitted documents', 'History']);
  assert.ok(sections.every(s => !s.open));
  assert.ok(view.container.querySelector('.follow-up')!.compareDocumentPosition(sections[0]) & Node.DOCUMENT_POSITION_FOLLOWING);
  for (const removed of ['Questions for the recruiter', 'Your workspace notes', 'Company contact'])
    assert.equal(view.queryByText(removed), null, removed);
  assert.equal(view.container.querySelector('.follow-up textarea'), null, 'only the draft button shows before a draft exists');
  fireEvent.click(button);
  await waitFor(() => assert.ok(requests.some(r => r.url === '/api/applications/application-fixture/follow-up/draft' && r.method === 'POST')));
});

test('the draft text box saves exactly what was typed, and sending saves unsaved edits first', async () => {
  const requests = server(summary({ draft }));
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, followUps: [summary({ draft })] }, mutate, go }));
  const body = await view.findByLabelText('Email') as HTMLTextAreaElement;
  assert.equal(body.value, draft.body);
  fireEvent.change(body, { target: { value: typed } });
  fireEvent.click(view.getByRole('button', { name: 'Save edits' }));
  await waitFor(() => assert.ok(requests.some(r => r.method === 'PUT')));
  const put = requests.find(r => r.method === 'PUT')!;
  assert.equal(put.body.body, typed);
  assert.deepEqual({ ...put.body, body: undefined }, { expectedVersion: 2, to: draft.to, subject: draft.subject, body: undefined });

  fireEvent.change(view.getByLabelText('Subject'), { target: { value: 'Café “follow-up” 👋🏽' } });
  fireEvent.click(view.getByRole('button', { name: 'Send email' }));
  assert.ok(view.getByRole('group', { name: 'Confirm sending' }).textContent!.includes('dana@example.com'));
  fireEvent.click(view.getByRole('button', { name: /Send now/ }));
  await waitFor(() => assert.ok(requests.some(r => r.url.endsWith('/send'))));
  const [save, send] = requests.filter(r => r.method === 'PUT' || r.url.endsWith('/send')).slice(-2);
  assert.equal(save.body.subject, 'Café “follow-up” 👋🏽', 'the unsaved subject is saved before sending');
  assert.deepEqual(send.body, { expectedVersion: 4, draftId: 'draft-4' });
  await view.findByText(/Gmail's sent copy matches the draft exactly/);
});

test('the box never sends a draft other than the text shown, even after another window saved a newer one', async () => {
  const requests = server(summary({ draft }));
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, followUps: [summary({ draft })] }, mutate, go }));
  const body = await view.findByLabelText('Email') as HTMLTextAreaElement;
  fireEvent.change(body, { target: { value: typed } });
  const newer = summary({ version: 5, draft: { ...draft, id: 'draft-other', to: 'different@example.com', body: 'Another window' } });
  view.rerender(createElement(ApplicationDetail, { application, state: { ...state, followUps: [newer] }, mutate, go }));
  assert.equal(body.value, typed, 'unsaved text is kept when a newer draft arrives');
  fireEvent.change(body, { target: { value: draft.body } });
  fireEvent.click(view.getByRole('button', { name: 'Send email' }));
  assert.ok(view.getByRole('group', { name: 'Confirm sending' }).textContent!.includes('dana@example.com'));
  fireEvent.click(view.getByRole('button', { name: /Send now/ }));
  await waitFor(() => assert.ok(requests.some(r => r.url.endsWith('/send'))));
  const put = requests.find(r => r.method === 'PUT');
  assert.deepEqual(put?.body, { expectedVersion: 5, to: draft.to, subject: draft.subject, body: draft.body }, 'the shown text is saved before sending');
});

test('sending needs explicit Gmail permission and a recipient', async () => {
  server(summary({ draft: { ...draft, to: '' } }), { connected: true, sendGranted: false, account: 'candidate@example.net' });
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, followUps: [summary({ draft: { ...draft, to: '' } })] }, mutate, go }));
  await view.findByRole('button', { name: 'Authorize Gmail sending' });
  assert.equal(view.queryByRole('button', { name: 'Send email' }), null);
  assert.ok(view.getByText(/No employer email is on file/));
});

test('the revise subsection is collapsed and sends the instruction with the current box', async () => {
  const requests = server(summary({ draft }));
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, followUps: [summary({ draft })] }, mutate, go }));
  const revise = (await view.findByText('Revise with AI')).closest('details') as HTMLDetailsElement;
  assert.equal(revise.open, false);
  fireEvent.change(view.getByLabelText('Email'), { target: { value: typed } });
  fireEvent.change(view.getByLabelText('What should change?'), { target: { value: 'Shorter, please' } });
  fireEvent.click(view.getByRole('button', { name: /Revise draft/ }));
  await waitFor(() => assert.ok(requests.some(r => r.url.endsWith('/revise'))));
  assert.deepEqual(requests.find(r => r.url.endsWith('/revise'))!.body, {
    expectedVersion: 2, instruction: 'Shorter, please', to: draft.to, subject: draft.subject, body: typed,
  });
});


test('historical reviewed drafts keep a plain source label', async () => {
  const reviewedDraft: FollowUpDraft = { ...draft, source: 'reviewed', review: { model: 'claude-opus-5-5', effort: 'high' } };
  server(summary({ draft: reviewedDraft }));
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, followUps: [summary({ draft: reviewedDraft })] }, mutate, go }));
  await view.findByText(/Reviewed by Claude/);
  assert.equal(view.container.textContent?.includes('Claude Opus 5.5'), false);
});

test('the Follow-up column button drafts in place, then opens the draft; unsent applications get none', () => {
  const props = { label: 'Fixture Company · Senior Engineer', go, notify: () => {} };
  const applied = { ...application, status: 'applied' as const };
  let view = render(createElement(FollowUpEmailButton, { ...props, application: applied }));
  assert.ok(view.getByRole('button', { name: 'Draft follow-up email for Fixture Company · Senior Engineer' }));
  view.unmount();
  view = render(createElement(FollowUpEmailButton, { ...props, application: applied, followUp: summary({ draft }) }));
  assert.equal(view.getByRole('link').getAttribute('href'), '#applications/application-fixture');
  view.unmount();
  view = render(createElement(FollowUpEmailButton, { ...props, application: applied,
    followUp: summary({ generation: { kind: 'generate', status: 'drafting', startedAt: '2026-10-15T12:00:00Z', requestId: 'r' } }) }));
  assert.ok(view.getByRole('status', { name: /Drafting follow-up email/ }));
  view.unmount();
  view = render(createElement(FollowUpEmailButton, { ...props, application: { ...application, status: 'ready', submittedAt: undefined } }));
  assert.equal(view.container.innerHTML, '');
});
