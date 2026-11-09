// Run with: node --import tsx --test app/client/testing/components.test.ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
const {
  dom, createElement, renderToStaticMarkup,
  render, cleanup, fireEvent, waitFor, within, mutationRecorder,
} = await import('./test-render');
const { Agents } = await import('../pages/Agents');
const { OpeningActions } = await import('../openings/OpeningWorkflow');
const { default: CodexModels } = await import('../settings/CodexModels');
const { CodexModelCatalogProvider } = await import('../workspace/CodexModelCatalog');
const { default: ApprovalRequest } = await import('../agents/ApprovalRequest');
const { default: Questions } = await import('../pages/Questions');
const { Openings, OpeningDetail } = await import('../pages/Openings');
const { todayQueue } = await import('../pages/Overview');
const { Companies } = await import('../pages/Companies');
const { ApplicationDetail } = await import('../pages/Applications');
const { PreparationStatusLine } = await import('../preparation/ApplicationPreparation');
import { application, opening, task, questionTask, state, connectedStatus, questionContext } from './component-fixtures';
import { snapshots } from './component-snapshots';
import { autofill, resumeDocument, coverLetterDocument } from './component-fixtures';
import type { AutofillRecord } from '../../shared/greenhouse-autofill';
import type { ApplicationPreparation } from '../../shared/application-preparation';

const { calls, mutate } = mutationRecorder();
const radios = (group: HTMLElement) => within(group).getAllByRole('radio') as HTMLButtonElement[];
const checkedLabel = (group: HTMLElement) => radios(group).find(radio => radio.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label');
const radioNamed = (group: HTMLElement, name: string) => radios(group).find(radio => radio.getAttribute('aria-label') === name)!;
const go = () => {};
const agent = () => {};
const personal = async () => ({});
globalThis.fetch = async input => {
  const url = String(input);
  if (url === '/api/agent/status') return Response.json(connectedStatus);
  if (url === '/api/questions/context') return Response.json(questionContext);
  throw new Error(`Unexpected request: ${url}`);
};
afterEach(() => { calls.length = 0; });
function snapshot(name: keyof typeof snapshots, html: string) {
  assert.equal(html, snapshots[name]);
}

test('Agents SSR shows messages but cannot load pending approval without effects', () => {
  const html = renderToStaticMarkup(createElement(Agents, { state, selected: task.id, go, mutate, context: { documentIds: [] } }));
  assert.ok(html.includes('Review the opening'));
  assert.ok(!html.includes('approval-request'));
  snapshot('agentsInitial', html);
});
test('Agents live conversation loads approval and preserves its response payload', async () => {
  const view = render(createElement(Agents, { state, selected: task.id, go, mutate, context: { documentIds: [] } }));
  await view.findByText('Inspect the fixture files');
  snapshot('agentsLive', view.container.innerHTML);
  fireEvent.click(view.getByText('Approve this request once'));
  await waitFor(() => assert.deepEqual(calls, [{ path: '/api/tasks/task-fixture/respond', body: { requestId: 'request-fixture', response: { decision: 'accept' } }, method: undefined }]));
});
test('Questions conversation preserves message rendering and follow-up payload', async () => {
  const view = render(createElement(Questions, { state, selected: questionTask.id, go, mutate,
    renderApproval: (t, event) => createElement(ApprovalRequest, { key: event.requestId, task: t, event, mutate }),
  }));
  await view.findByText('Agent connection available');
  snapshot('questions', view.container.innerHTML);
  fireEvent.change(view.getByLabelText('Follow-up question'), { target: { value: 'Clarify the evidence' } });
  fireEvent.click(view.getByText('Send follow-up'));
  await waitFor(() => assert.equal(calls.length, 1));
  const body = calls[0].body as { prompt: string; clientRequestId: string; model?: string };
  assert.equal(calls[0].path, '/api/tasks/question-fixture/message');
  assert.equal(body.prompt, 'Clarify the evidence');
  assert.equal(Object.hasOwn(body, 'model'), false);
  assert.match(body.clientRequestId, /^[0-9a-f-]{36}$/);
});

test('Questions sends an explicitly chosen follow-up model and preserves provider-pinned Automatic behavior', async () => {
  const previousFetch = globalThis.fetch;
  const models = [
    { id: 'codex', model: 'codex-default', displayName: 'Codex Default', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'claude', model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'claude', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'hidden', model: 'hidden-model', displayName: 'Hidden model', hidden: true, isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'blocked', model: 'blocked-model', displayName: 'No offered effort', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
  ];
  globalThis.fetch = async input => String(input) === '/api/agent/models'
    ? Response.json({ models, error: null, refreshing: false, refreshedAt: '2026-10-20T12:00:00Z' })
    : previousFetch(input);
  try {
    const settings = { ...state.settings, codexModels: { questions: 'claude-opus-5-5' }, codexEfforts: { questions: 'high' } };
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(Questions, {
      state: { ...state, settings }, selected: questionTask.id, go, mutate,
      renderApproval: (t: unknown, event: { requestId: string }) => createElement(ApprovalRequest, { key: event.requestId, task: t, event, mutate }),
    })));
    const picker = view.getByRole('radiogroup', { name: 'Model for this message' });
    await waitFor(() => assert.equal(radios(picker).length, 4));
    assert.deepEqual(radios(picker).map(radio => radio.textContent), ['Auto', 'D', 'N', 'O']);
    assert.equal(checkedLabel(picker), 'Automatic · fixture-model', 'Automatic keeps the existing Codex provider when settings select Claude');
    assert.deepEqual(radios(picker).map(radio => radio.getAttribute('aria-label')), ['Automatic · fixture-model', 'Default · Codex', 'No offered effort · Codex', 'Opus 5.5 · Claude Code']);
    assert.equal(radioNamed(picker, 'No offered effort · Codex').disabled, true);
    assert.equal(radioNamed(picker, 'Opus 5.5 · Claude Code').disabled, false);
    const help = view.getByRole('button', { name: 'About message model choice' });
    fireEvent.focus(help);
    assert.match(view.getByRole('tooltip').textContent!, /another provider starts a new thread/);
    assert.match(view.getByRole('tooltip').textContent!, /tool history is not copied/);
    assert.match(view.getByRole('tooltip').textContent!, /Opus 5\.5/, 'the tooltip carries the letter key');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(radioNamed(picker, 'Opus 5.5 · Claude Code'));
    fireEvent.change(view.getByLabelText('Follow-up question'), { target: { value: 'Use Claude for this answer' } });
    fireEvent.click(view.getByText('Send follow-up'));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].path, '/api/tasks/question-fixture/message');
    assert.deepEqual(calls[0].body, {
      prompt: 'Use Claude for this answer',
      clientRequestId: (calls[0].body as { clientRequestId: string }).clientRequestId,
      model: 'claude-opus-5-5',
    });
    assert.equal(Object.hasOwn(calls[0].body as object, 'effort'), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Questions sends an explicitly chosen model on a new question', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async input => String(input) === '/api/agent/models'
    ? Response.json({ models: [
      { id: 'codex', model: 'codex-default', displayName: 'Codex Default', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
      { id: 'claude', model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'claude', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ], error: null, refreshing: false, refreshedAt: '2026-10-20T12:00:00Z' })
    : previousFetch(input);
  try {
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(Questions, {
      state, selected: 'new', go, mutate,
      renderApproval: (t: unknown, event: { requestId: string }) => createElement(ApprovalRequest, { key: event.requestId, task: t, event, mutate }),
    })));
    const picker = view.getByRole('radiogroup', { name: 'Model for this message' });
    await waitFor(() => assert.equal(radios(picker).length, 3));
    assert.equal(checkedLabel(picker), 'Automatic · Codex Default');
    const resolved = radioNamed(picker, 'Default · Codex (automatic)');
    assert.ok(resolved.classList.contains('is-default'), 'the model Automatic resolves to carries the dot');
    fireEvent.click(radioNamed(picker, 'Opus 5.5 · Claude Code'));
    fireEvent.change(view.getByLabelText('Your question'), { target: { value: 'What should I emphasize?' } });
    fireEvent.click(view.getByRole('button', { name: /Ask Claude Code/ }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].path, '/api/tasks');
    assert.equal((calls[0].body as { model?: string }).model, 'claude-opus-5-5');
    assert.equal(Object.hasOwn(calls[0].body as object, 'effort'), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Questions disables active-turn model steering and explains that the current model is unchanged', async () => {
  const running = { ...questionTask, status: 'running' as const };
  const view = render(createElement(Questions, {
    state: { ...state, tasks: [task, running] }, selected: running.id, go, mutate,
    renderApproval: (t, event) => createElement(ApprovalRequest, { key: event.requestId, task: t, event, mutate }),
  }));
  await view.findByText('Agent connection available');
  assert.ok(radios(view.getByRole('radiogroup', { name: 'Model for this message' })).every(radio => radio.disabled));
  fireEvent.focus(view.getByRole('button', { name: 'About message model choice' }));
  assert.match(view.getByRole('tooltip').textContent!, /current active turn keeps the model it started with/);
});

test('Opening application-stage form preserves HTML and PATCH payload', async () => {
  const view = render(createElement(OpeningDetail, { opening, state, go, personal, mutate }));
  const applicationPanel = view.container.querySelector('.opening-application') as HTMLDetailsElement;
  assert.equal(applicationPanel.open, false);
  fireEvent.click(applicationPanel.querySelector('summary')!);
  const form = view.container.querySelector('.opening-application-form');
  assert.ok(form);
  snapshot('openingTracking', form!.outerHTML);
  fireEvent.change(view.getByLabelText('Next action'), { target: { value: 'Schedule call' } });
  fireEvent.submit(form!);
  await waitFor(() => assert.deepEqual(calls, [{ path: '/api/applications/application-fixture', method: 'PATCH',
    body: { expectedVersion: 4, status: 'interviewing', nextAction: 'Schedule call', followUp: '2026-10-06' } }]));
});
test('Application detail stage form preserves HTML and its broader PATCH payload', async () => {
  const view = render(createElement(ApplicationDetail, { application, state, go, mutate, agent }));
  const form = view.getByText('Save application').closest('form');
  assert.ok(form);
  snapshot('applicationTracking', form!.outerHTML);
  fireEvent.change(view.getAllByLabelText('Next action').at(-1)!, { target: { value: 'Schedule call' } });
  fireEvent.submit(form!);
  await waitFor(() => assert.deepEqual(calls, [{ path: '/api/applications/application-fixture', method: 'PATCH', body: {
    expectedVersion: 4, status: 'interviewing', nextAction: 'Schedule call', followUp: '2026-10-06', contacts: 'Recruiter', notes: 'Discuss on-call',
  } }]));
});


test('Research notes use accessible tooltips, assessments are bullets, and contact is collapsed last', async () => {
  const note = 'Researched from the linked official sources. See the saved research conversation for evidence and limitations.';
  const assessment = 'The supplied resume supports the five-year requirement, founder-facing independent delivery, server reliability, and AI-assisted development duties. The role requests strong Next.js and Django experience, which is not established. Adjacent React and backend experience supports learning those frameworks. Confirm the specific geographic restrictions and the expected on-call schedule before applying. Employer flexibility claims do not establish actual working hours. The posted compensation varies by location.';
  const researched = { ...opening, verificationNotes: note, assessmentSourceHash: opening.hash,
    assessmentDetails: { technicalFit: assessment, remoteFit: 'US remote; state eligibility needs confirmation.', wlbOutlook: 'On-call expectations are unknown.' } };
  const view = render(createElement(OpeningDetail, { opening: researched, state, go, personal, mutate }));
  const research = view.container.querySelector('.opening-research-details') as HTMLDetailsElement;
  const contact = view.container.querySelector('.opening-company-contact') as HTMLDetailsElement;
  assert.equal(contact.open, false);
  assert.equal(view.container.querySelector('.detail-content')!.lastElementChild, contact);
  assert.ok(contact.previousElementSibling!.classList.contains('opening-application'));
  assert.equal((contact.previousElementSibling as HTMLDetailsElement).open, false);
  const questions = contact.previousElementSibling!.previousElementSibling as HTMLDetailsElement;
  assert.ok(questions.classList.contains('opening-questions'));
  assert.equal(questions.open, false);
  assert.ok(!view.container.textContent!.includes(note));
  const bullets = [...view.container.querySelectorAll('.research-text')][0].querySelectorAll('ul.research-bullets > li');
  assert.equal(bullets.length, 6);
  assert.equal([...bullets].map(li => li.textContent).join(' '), assessment);
  const info = view.getByRole('button', { name: 'About role research' });
  fireEvent.focus(info);
  assert.ok(view.getByRole('tooltip').textContent!.includes(note));
  assert.equal(info.getAttribute('aria-describedby'), view.getByRole('tooltip').id);
  assert.equal(research.open, false);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('tooltip'), null);
  fireEvent.mouseEnter(info);
  assert.ok(view.getByRole('tooltip'));
  fireEvent.pointerDown(document.body);
  assert.equal(view.queryByRole('tooltip'), null);
});

test('Collapsed company contact retains its copy payload after expansion', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  try {
    const view = render(createElement(OpeningDetail, { opening, state, go, personal, mutate }));
    fireEvent.click(view.getByText('Company contact'));
    fireEvent.click(view.getByRole('button', { name: 'Copy company details' }));
    await view.findByRole('button', { name: 'Company details copied' });
    assert.ok(copied.startsWith(`${opening.company}\n${opening.title}\n`));
    assert.ok(copied.includes(opening.url));
    assert.equal(calls.length, 0);
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});


test('Opening legacy priority preferences normalize away and Fit cycles only technical and WLB', async () => {
  const key = 'fieldwork.openings.sort.v2';
  const previous = localStorage.getItem(key);
  localStorage.setItem(key, 'priority');
  try {
    const savedFilters = [{ id: 'legacy', name: 'Legacy', filters: { priority: 'C', sort: 'priority', autofillEligible: false } }];
    const view = render(createElement(Openings, { state: { ...state, applications: [], savedFilters }, selected: '', go, personal, mutate }));
    const sort = view.getByLabelText('Sort opportunities') as HTMLSelectElement;
    assert.equal(sort.value, 'docs-first');
    assert.equal(localStorage.getItem(key), 'docs-first');
    assert.equal(view.queryByLabelText('Role priority'), null);
    assert.equal([...sort.options].some(option => option.value === 'priority'), false);
    const fit = () => view.getByRole('button', { name: /^Fit\./ });
    fireEvent.click(fit());
    assert.equal(sort.value, 'technical-high');
    fireEvent.click(fit());
    assert.equal(sort.value, 'wlb-high');
    fireEvent.click(fit());
    assert.equal(sort.value, 'technical-high');
    fireEvent.change(view.getByLabelText('Load saved filter'), { target: { value: 'legacy' } });
    assert.equal(sort.value, 'docs-first');
    assert.ok(view.container.querySelector(`tr[data-opening-id="${opening.id}"]`));
    fireEvent.click(view.getByRole('button', { name: 'Save filter' }));
    fireEvent.change(view.getByLabelText('Filter name'), { target: { value: 'Normalized' } });
    fireEvent.submit(view.getByLabelText('Filter name').closest('form')!);
    await waitFor(() => assert.equal(calls.length, 1));
    const saved = calls[0].body as { filters: Record<string, unknown> };
    assert.equal(calls[0].path, '/api/filters');
    assert.equal(Object.hasOwn(saved.filters, 'priority'), false);
    assert.equal(saved.filters.sort, 'docs-first');
  } finally {
    if (previous === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previous);
  }
});

test('Today review queue includes unreviewed openings without any letter rating', () => {
  const queue = todayQueue({ ...state, applications: [], tasks: [] });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, opening.id);
  assert.equal(queue[0].detail, 'Not reviewed yet');
  assert.equal(todayQueue({ ...state, tasks: [] }).some(item => item.kind === 'Review'), false);
});

test('Company list and detail retain research and deletion without priority controls or badges', () => {
  const company = { id: opening.company_id, name: opening.company, fields: { 'Careers URL': 'https://example.test/jobs', 'Industry / product': 'Fixture product' }, text: 'Fixture research', sourcePath: 'fixture/company.md', sourceDate: null, hash: 'company-hash' };
  const view = render(createElement(Companies, { state: { ...state, companies: [company] }, selected: company.id, go, personal, mutate, agent }));
  assert.equal(view.queryByLabelText('Monitoring priority'), null);
  assert.doesNotMatch(view.container.textContent!, /priority/i);
  assert.ok(view.getByRole('button', { name: `Delete ${company.name}` }));
  assert.equal(view.getAllByText('Fixture product').length, 2);
  assert.ok(view.getByRole('link', { name: opening.title }));
});

test('Opening list X hides immediately, saves not-interested metadata, and restores on failure', async () => {
  let rejectSave: (error: Error) => void = () => {};
  const updates: { id: string; fields: unknown }[] = [];
  const update = (id: string, fields: unknown) => {
    updates.push({ id, fields });
    return new Promise((_, reject) => { rejectSave = reject; });
  };
  const view = render(createElement(Openings, { state: { ...state, applications: [] }, selected: '', go, personal: update, mutate }));
  fireEvent.change(view.getByLabelText('Autofill support'), { target: { value: 'all' } });
  const button = view.getByRole('button', { name: `Not interested in ${opening.company} ${opening.title}` });
  assert.equal(button.getAttribute('title'), 'Not interested');
  fireEvent.click(button);
  assert.equal(view.container.querySelector(`tr[data-opening-id="${opening.id}"]`), null);
  assert.deepEqual(updates, [{ id: opening.id, fields: { dismissed: true } }]);
  assert.equal(calls.length, 0, 'does not call record deletion or another mutation');
  rejectSave(new Error('Fixture save failure'));
  await waitFor(() => assert.ok(view.container.querySelector(`tr[data-opening-id="${opening.id}"]`)));
  assert.match(view.getByRole('status').textContent!, /row has been restored/);
});

test('Dismissed openings can be found again with Include not interested', async () => {
  const next = { ...state, applications: [] };
  const props = { state: next, selected: '', go, personal: async () => ({}), mutate };
  const view = render(createElement(Openings, props));
  fireEvent.change(view.getByLabelText('Autofill support'), { target: { value: 'all' } });
  fireEvent.click(view.getByRole('button', { name: `Not interested in ${opening.company} ${opening.title}` }));
  assert.equal(view.container.querySelector(`tr[data-opening-id="${opening.id}"]`), null);
  await waitFor(() => {});
  view.rerender(createElement(Openings, { ...props, state: { ...next, personal: { ...next.personal, [opening.id]: { ...next.personal[opening.id], dismissed: true } } } }));
  fireEvent.click(view.getByLabelText('Include not interested'));
  await waitFor(() => assert.ok(view.container.querySelector(`tr[data-opening-id="${opening.id}"]`)));
});

test('Invert selection flips only the rows the filters show and drops hidden selections', async () => {
  const rows = [['alpha', 'Zyx Alpha'], ['beta', 'Zyx Beta'], ['gamma', 'Gamma Lead']]
    .map(([id, title]) => ({ ...opening, id: `opening-${id}`, title, hash: `hash-${id}` }));
  const view = render(createElement(Openings, { state: { ...state, applications: [], openings: rows }, selected: '', go, personal, mutate }));
  fireEvent.change(view.getByLabelText('Autofill support'), { target: { value: 'all' } });
  const box = (title: string) => view.getByLabelText(`Select ${opening.company} ${title}`) as HTMLInputElement;
  fireEvent.click(box('Zyx Alpha'));
  fireEvent.click(box('Gamma Lead'));
  fireEvent.change(view.getByPlaceholderText('Search company, role, or technology…'), { target: { value: 'zyx' } });
  assert.match(view.getByRole('toolbar', { name: 'Actions for selected openings' }).textContent!, /2 selected · 1 not shown/);
  fireEvent.click(view.getByRole('button', { name: 'Invert selection' }));
  assert.equal(box('Zyx Alpha').checked, false);
  assert.equal(box('Zyx Beta').checked, true);
  assert.equal(view.getByRole('toolbar', { name: 'Actions for selected openings' }).textContent!.includes('not shown'), false);
  fireEvent.change(view.getByPlaceholderText('Search company, role, or technology…'), { target: { value: '' } });
  assert.equal(box('Gamma Lead').checked, false);
  assert.equal(view.queryByRole('button', { name: 'Archive' }), null);
  assert.equal(view.queryByLabelText('Include archived'), null);
});

test('Opening an Opening marks its current posting reviewed; an already reviewed one sends nothing', async () => {
  const { setCsrf } = await import("../workspace/api");
  const priorFetch = globalThis.fetch;
  const requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('/api/personal/')) return priorFetch(input, init);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({});
  };
  setCsrf('fixture-token');
  try {
    const unseen = { ...state, personal: { [opening.id]: { version: 3, saved: true } } };
    let view = render(createElement(OpeningDetail, { opening, state: unseen, go, personal, mutate }));
    await waitFor(() => assert.equal(requests.length, 1));
    assert.deepEqual(requests[0], { url: `/api/personal/${opening.id}`, body: { expectedVersion: 3, reviewedHash: opening.hash } });
    assert.equal(view.queryByRole('button', { name: /Mark reviewed|Archive/ }), null);
    view.unmount();
    const reviewed = { ...state, personal: { [opening.id]: { version: 4, reviewedHash: opening.hash } } };
    view = render(createElement(OpeningDetail, { opening, state: reviewed, go, personal, mutate }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests.length, 1);
    view.unmount();
  } finally { globalThis.fetch = priorFetch; setCsrf(''); }
});
test('Collapsed Opening questions preserve their question submission and saved-answer links', async () => {
  const view = render(createElement(OpeningDetail, { opening, state, go, personal, mutate }));
  const questions = view.container.querySelector('.opening-questions') as HTMLDetailsElement;
  assert.equal(questions.open, false);
  assert.ok(questions.nextElementSibling!.classList.contains('opening-application'));
  fireEvent.click(questions.querySelector('summary')!);
  fireEvent.change(view.getByLabelText('Paste a question from the application'), { target: { value: 'Why this role?' } });
  fireEvent.click(view.getByRole('button', { name: 'Get an answer' }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].path, `/api/openings/${encodeURIComponent(opening.id)}/questions`);
  const body = calls[0].body as { question: string; clientRequestId: string };
  assert.equal(body.question, 'Why this role?');
  assert.match(body.clientRequestId, /^[0-9a-f-]{36}$/);
  await waitFor(() => assert.equal((view.getByLabelText('Paste a question from the application') as HTMLTextAreaElement).value, ''));
  assert.equal(questions.open, true);
  for (const saved of state.tasks.filter(t => t.context?.openingId === opening.id && t.preset === 'questions' && !t.autofillContext)) {
    assert.ok(questions.querySelector(`a[href="#questions/${saved.id}"]`));
  }
});


const modelGroupFor = (view: ReturnType<typeof render>, name: string) => view.getByRole('radiogroup', { name });

test('Codex settings offer advertised efforts and save model/effort preferences together', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ models: [
    { id: 'fixture', model: 'fixture', displayName: 'Fixture model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'low' }] },
    { id: 'other', model: 'other', displayName: 'High only', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ], error: null, refreshing: false, refreshedAt: '2026-10-06T18:00:00Z' });
  try {
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings: { ...state.settings, codexModels: {}, codexEfforts: {} } }, mutate, notify: () => {} })));
    const effort = () => modelGroupFor(view, 'Greenhouse search research effort');
    const model = () => modelGroupFor(view, 'Greenhouse search research');
    await waitFor(() => assert.equal(radios(effort()).length, 3));
    assert.deepEqual(radios(effort()).map(radio => radio.getAttribute('aria-label')), ['High', 'Medium', 'Low']);
    assert.deepEqual(radios(effort()).map(radio => radio.textContent), ['H', 'M', 'L']);
    assert.equal(checkedLabel(model()), 'Fixture model · Codex (recommended default)');
    assert.ok(radioNamed(model(), 'Fixture model · Codex (recommended default)').classList.contains('is-default'));
    assert.equal(checkedLabel(effort()), 'High');
    assert.ok(radios(effort()).every(radio => !/default/i.test(radio.getAttribute('aria-label')!)));
    assert.equal((view.getByRole('button', { name: 'Save model choices' }) as HTMLButtonElement).disabled, true, 'showing implicit choices does not create saved overrides');
    fireEvent.click(radioNamed(effort(), 'Low'));
    fireEvent.click(view.getByRole('button', { name: 'Save model choices' }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(calls[0], { path: '/api/settings/models', method: undefined, body: { codexModels: {}, codexEfforts: { 'greenhouse-pull': 'low' }, expectedVersion: state.settings.version } });
    await waitFor(() => assert.equal(radios(model()).every(radio => !radio.disabled), true));
    fireEvent.click(radioNamed(model(), 'High only · Codex'));
    assert.equal(checkedLabel(effort()), 'Low (unavailable)', 'switching models never silently changes effort');
    assert.match(view.getByRole('alert').textContent!, /does not support low effort/);
    fireEvent.click(radioNamed(effort(), 'High'));
    assert.equal(view.queryByRole('alert'), null);
    assert.ok(radios(model()).every(radio => !/default/i.test(radio.getAttribute('aria-label')!)), 'an explicit choice shows no default wording');
    fireEvent.click(view.getByRole('button', { name: 'Use defaults for all' }));
    assert.equal(checkedLabel(model()), 'Fixture model · Codex (recommended default)');
    assert.equal(checkedLabel(effort()), 'High');
  } finally { globalThis.fetch = previousFetch; }
});


test('Unset model choices follow refreshed recommendations without creating saved overrides', async () => {
  const previousFetch = globalThis.fetch;
  let recommended = 'first';
  globalThis.fetch = async () => Response.json({
    models: ['first', 'second'].map(model => ({ id: model, model, displayName: model, isDefault: model === recommended, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] })),
    error: null, refreshing: false, refreshedAt: '2026-10-06T18:00:00Z',
  });
  try {
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings: { ...state.settings, codexModels: {}, codexEfforts: {} } }, mutate, notify: () => {} })));
    const model = () => modelGroupFor(view, 'Questions and follow-ups');
    await waitFor(() => assert.equal(checkedLabel(model()), 'First · Codex (recommended default)'));
    recommended = 'second';
    fireEvent.click(view.getByRole('button', { name: 'Refresh models' }));
    await waitFor(() => assert.equal(checkedLabel(model()), 'Second · Codex (recommended default)'));
    assert.equal((view.getByRole('button', { name: 'Save model choices' }) as HTMLButtonElement).disabled, true);
    assert.equal(calls.length, 0);
    fireEvent.click(radioNamed(model(), 'First · Codex'));
    fireEvent.click(view.getByRole('button', { name: 'Save model choices' }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(calls[0].body, { codexModels: { questions: 'first' }, codexEfforts: {}, expectedVersion: state.settings.version });
  } finally { globalThis.fetch = previousFetch; }
});


test('Codex settings drop saved choices for request types that no longer exist', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ models: [
    { id: 'fixture', model: 'fixture', displayName: 'Fixture model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
  ], error: null, refreshing: false, refreshedAt: '2026-10-06T18:00:00Z' });
  try {
    const settings = { ...state.settings, codexModels: { 'interview-prep': 'fixture', questions: 'fixture' }, codexEfforts: { 'interview-prep': 'low' } } as typeof state.settings;
    const view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings }, mutate, notify: () => {} })));
    assert.equal(view.queryByRole('radiogroup', { name: 'Interview preparation' }), null);
    const effort = () => modelGroupFor(view, 'Questions and follow-ups effort');
    await waitFor(() => assert.equal(radios(effort()).length, 2));
    fireEvent.click(radioNamed(effort(), 'Low'));
    fireEvent.click(view.getByRole('button', { name: 'Save model choices' }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(calls[0].body, { codexModels: { questions: 'fixture' }, codexEfforts: { questions: 'low' }, expectedVersion: state.settings.version });
  } finally { globalThis.fetch = previousFetch; }
});


test('Codex settings show provider errors and disable only that provider', async () => {
  const previousFetch = globalThis.fetch;
  const codex = { id: 'codex', model: 'codex', displayName: 'Codex model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
  const claude = (efforts: { reasoningEffort: string }[]) => ({ id: 'claude', model: 'claude', displayName: 'Claude model', provider: 'claude', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: efforts });
  const catalog = (body: object) => { globalThis.fetch = async () => Response.json({ refreshing: false, refreshedAt: '2026-10-06T18:00:00Z', ...body }); };
  const settings = { ...state.settings, codexModels: {}, codexEfforts: {} };
  try {
    catalog({ models: [codex, claude([{ reasoningEffort: 'high' }])], error: null, providerErrors: { claude: 'Claude Code is not signed in for Fieldwork.' } });
    let view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings: { ...settings, codexModels: { questions: 'claude' } } }, mutate, notify: () => {} })));
    let model = () => modelGroupFor(view, 'Questions and follow-ups');
    const effort = () => modelGroupFor(view, 'Questions and follow-ups effort');
    await view.findByText('Claude Code is not signed in for Fieldwork.');
    assert.deepEqual(radios(model()).map(radio => radio.getAttribute('aria-label')), ['Model · Codex', 'Model · Claude Code']);
    assert.deepEqual(radios(model()).map(radio => radio.textContent), ['M', 'O'], 'a Claude model never reuses a Codex letter');
    assert.equal(radioNamed(model(), 'Model · Codex').disabled, false);
    assert.equal(radioNamed(model(), 'Model · Claude Code').disabled, true);
    assert.equal(checkedLabel(model()), 'Model · Claude Code');
    assert.ok(radios(effort()).every(radio => radio.disabled), 'a provider error blocks a cached model with supported efforts');
    fireEvent.click(radioNamed(model(), 'Model · Codex'));
    assert.ok(radios(effort()).every(radio => !radio.disabled), 'the healthy provider remains usable');
    fireEvent.click(view.getByRole('button', { name: 'Use defaults for all' }));
    assert.equal(checkedLabel(model()), 'Model · Codex (recommended default)', 'clearing an explicit preference displays the recommended model during an outage');
    cleanup();
    catalog({ models: [codex, claude([{ reasoningEffort: 'high' }])], error: 'Codex is unavailable.' });
    view = render(createElement(CodexModelCatalogProvider, null, createElement(CodexModels, { state: { ...state, settings }, mutate, notify: () => {} })));
    model = () => modelGroupFor(view, 'Questions and follow-ups');
    await view.findByText('Codex is unavailable.');
    assert.equal(radios(model()).length, 2, 'no separate default option is offered');
    assert.equal(radioNamed(model(), 'Model · Codex (recommended default)').disabled, true);
    assert.equal(radioNamed(model(), 'Model · Claude Code').disabled, false);
    fireEvent.click(radioNamed(model(), 'Model · Claude Code'));
    assert.ok(radios(modelGroupFor(view, 'Questions and follow-ups effort')).every(radio => !radio.disabled));
  } finally { globalThis.fetch = previousFetch; }
});



test('Opening materials consolidate stopped-preparation warnings into one tooltip and retry from Generate Docs', async () => {
  const previousFetch = globalThis.fetch;
  const role = { ...opening, url: 'https://job-boards.greenhouse.io/example/jobs/123' };
  const saved: AutofillRecord = { ...autofill, stale: true, attachments: [],
    dynamicQuestions: [{ id: 'q', key: 'q', label: 'Education', kind: 'select', required: true, maxLength: 100 }],
    review: [{ label: 'Education', required: true, reason: 'Codex can interpret this unmatched question...' }, { label: 'Resume/CV', required: true, reason: 'Attach manually' }],
  };
  const preparation: ApplicationPreparation = { id: 'run', openingId: opening.id, applicationId: application.id, status: 'failed', phase: 'answers', message: 'Stopped', error: 'Your saved profile changed.', openingHash: opening.hash, documentIds: ['resume', 'letter'], taskIds: [], supportedForm: true, createdAt: saved.createdAt, updatedAt: saved.createdAt };
  globalThis.fetch = async input => String(input).endsWith('/status')
    ? Response.json({ running: false, phase: 'idle', message: 'No task running' }) : Response.json([saved]);
  try {
    const view = render(createElement(OpeningActions, { opening: role, mutate, go, state: { ...state, tasks: [], documents: [], preparations: [preparation] } }));
    await view.findByText(/Saved version 1/);
    const flag = view.getByRole('button', { name: 'Application materials need attention' });
    assert.equal(view.container.querySelectorAll('.material-warning').length, 1);
    assert.equal(view.container.textContent?.includes('Your saved profile changed'), false);
    fireEvent.mouseEnter(flag);
    assert.match(view.getByRole('tooltip').textContent || '', /Saved profile answers changed/);
    assert.match(view.container.querySelector('.material-warning-summary')?.textContent || '', /Written-answer preparation stopped/);
    assert.equal(view.getByRole('tooltip').textContent?.includes('Written-answer preparation stopped'), false);
    assert.match(view.getByRole('tooltip').textContent || '', /Resume and cover letter PDFs are saved/);
    for (const removed of ['Copying records this application', 'Awaiting Codex', 'Codex can interpret', 'Finish on the application', 'View generation details or revise'])
      assert.equal(view.container.textContent?.includes(removed), false);
    assert.equal(view.queryByRole('button', { name: 'Autofill Script' }), null);
    assert.ok(view.getByText('Education · Preparation stopped'));
    fireEvent.click(view.getByRole('button', { name: 'Generate Docs' }));
    await waitFor(() => assert.equal(calls[0]?.path, `/api/openings/${encodeURIComponent(opening.id)}/prepare`));
  } finally { cleanup(); globalThis.fetch = previousFetch; }
});

test('A submitted application\'s Opening drops out-of-date and Finish warnings', async () => {
  const previousFetch = globalThis.fetch;
  const role = { ...opening, url: 'https://job-boards.greenhouse.io/example/jobs/123' };
  const rules = 'Resume writing rules changed. Generate a new resume.';
  const documents = [{ ...resumeDocument, writingRuleWarning: rules }, coverLetterDocument];
  const saved: AutofillRecord = { ...autofill, stale: true, staleReasons: [rules, 'Saved profile answers changed.'],
    review: [{ label: 'Pronouns', required: false, reason: 'Answer on the application page.' }] };
  globalThis.fetch = async input => String(input).endsWith('/status')
    ? Response.json({ running: false, phase: 'idle' }) : Response.json([saved]);
  try {
    for (const applications of [[application], []]) {
      const view = render(createElement(OpeningActions, { opening: role, mutate, go, state: { ...state, applications, tasks: [], documents, preparations: [] } }));
      await view.findByRole('button', { name: 'Autofill Script' });
      const summary = view.container.querySelector('.material-warning-summary')?.textContent || '';
      const resumeTitle = view.getByRole('link', { name: 'Resume PDF' }).getAttribute('title') || '';
      if (applications.length) {
        assert.equal(view.container.querySelector('.materials-need-attention'), null);
        assert.equal(summary, '');
        assert.equal(resumeTitle, '');
      } else {
        assert.match(summary, /Saved materials need updating/);
        fireEvent.mouseEnter(view.getByRole('button', { name: 'Application materials need attention' }));
        assert.match(view.getByRole('tooltip').textContent || '', /1 item still needs attention under Finish on the application/);
        assert.equal(resumeTitle, rules);
      }
      cleanup();
    }
  } finally { cleanup(); globalThis.fetch = previousFetch; }
});

test('Ready materials offer separate resume, cover-letter and autofill refresh controls', async () => {
  const previousFetch = globalThis.fetch;
  const requestPaths: string[] = [];
  const role = { ...opening, url: 'https://job-boards.greenhouse.io/example/jobs/123' };
  const documents = [resumeDocument, coverLetterDocument];
  const saved = { ...autofill, version: 2, createdAt: '2026-10-07T10:00:00Z' };
  if (questionTask.preset !== 'questions') throw new Error('Expected the question fixture');
  const failedAnswer = { ...questionTask, updatedAt: '2026-10-07T09:00:00Z', status: 'completed' as const,
    autofillContext: { scriptId: 'old-script', url: role.url, openingHash: role.hash, knowledgeHash: 'fixture', questions: [] },
    autofillResult: { status: 'failed', error: 'Previous Greenhouse fetch failed' } };
  globalThis.fetch = async input => {
    const path = String(input); requestPaths.push(path);
    if (path.endsWith('/status')) return Response.json({ running: false, phase: 'idle' });
    if (path.endsWith('?history=1')) return Response.json([
      { id: saved.id, version: saved.version, createdAt: saved.createdAt },
      { id: 'earlier-script', version: 1, createdAt: '2026-10-06T10:00:00Z' },
    ]);
    return Response.json([saved]);
  };
  try {
    const view = render(createElement(OpeningActions, { opening: role, mutate, go, state: { ...state, tasks: [failedAnswer], documents, preparations: [] } }));
    await view.findByRole('button', { name: 'Autofill Script' });
    assert.ok(requestPaths.some(path => path.endsWith('/autofill?latest=1')));
    assert.equal(requestPaths.some(path => path.endsWith('?history=1')), false, 'script history stays lazy');
    const initialStatusReads = requestPaths.filter(path => path.endsWith('/status')).length;
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.equal(requestPaths.filter(path => path.endsWith('/status')).length, initialStatusReads, 'idle status does not keep polling');
    fireEvent.focus(window);
    await waitFor(() => assert.equal(requestPaths.filter(path => path.endsWith('/status')).length, initialStatusReads + 1));
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent.focus(window);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requestPaths.filter(path => path.endsWith('/status')).length, initialStatusReads + 1, 'hidden tabs do not poll');
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    fireEvent.click(view.getByText('Earlier scripts'));
    await view.findByRole('link', { name: /Version 1/ });
    assert.equal(requestPaths.filter(path => path.endsWith('?history=1')).length, 1);
    assert.equal(view.queryByRole('button', { name: 'Application materials need attention' }), null, 'a newer complete script resolves an older packaging failure');
    assert.equal(view.queryByRole('button', { name: 'Generate Docs' }), null);
    assert.equal(view.getByRole('link', { name: 'Resume PDF' }).getAttribute('href'), '/api/documents/resume/download');
    assert.equal(view.getByRole('link', { name: 'Cover letter PDF' }).getAttribute('href'), '/api/documents/cover-letter/download');
    const resumeRefresh = view.getByRole('button', { name: 'Generate a new resume version' });
    assert.equal(resumeRefresh.title, 'Generate a new version');
    fireEvent.click(resumeRefresh);
    await waitFor(() => assert.deepEqual(calls[0]?.body, { documentKind: 'resume' }));
    fireEvent.click(view.getByRole('button', { name: 'Generate a new cover letter version' }));
    await waitFor(() => assert.deepEqual(calls[1]?.body, { documentKind: 'cover-letter' }));
    fireEvent.click(view.getByRole('button', { name: 'Refresh autofill script' }));
    await waitFor(() => assert.equal(calls[2]?.path, `/api/openings/${encodeURIComponent(opening.id)}/autofill/script/answers`));
  } finally { cleanup(); globalThis.fetch = previousFetch; }
});


test('Autofill status waits for a hidden tab to become visible', async () => {
  const previousFetch = globalThis.fetch;
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const role = { ...opening, url: 'https://job-boards.greenhouse.io/example/jobs/123' };
  let statusReads = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  globalThis.fetch = async input => {
    if (String(input).endsWith('/status')) { statusReads++; return Response.json({ running: false, phase: 'idle' }); }
    return Response.json([{ ...autofill, version: 1 }]);
  };
  try {
    const view = render(createElement(OpeningActions, { opening: role, mutate, go, state: { ...state, tasks: [], documents: [], preparations: [] } }));
    await view.findByText(/Saved version 1/);
    assert.equal(statusReads, 0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new dom.window.Event('visibilitychange'));
    await waitFor(() => assert.equal(statusReads, 1));
  } finally {
    cleanup(); globalThis.fetch = previousFetch;
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});

test('Non-autofill openings hide Generate Docs once the PDFs exist and show the start date beside Related application', () => {
  const documents = [resumeDocument, coverLetterDocument];
  const view = render(createElement(OpeningDetail, { opening, go, mutate, personal, state: { ...state, documents, tasks: [], preparations: [], applications: [{ ...application, applicationDate: '2026-10-06' }] } }));
  assert.equal(view.queryByRole('button', { name: 'Generate Docs' }), null);
  assert.equal(view.queryByRole('button', { name: 'Autofill Script' }), null);
  const meta = view.container.querySelector('.opening-application-meta');
  assert.ok(meta?.textContent?.includes('Related application'));
  assert.ok(meta?.textContent?.includes('Application started'));
  assert.equal(view.container.querySelector('.opening-workflow')?.textContent?.includes('Application started'), false);
});


test('Opening list Generate Docs shows items left to finish, blank before a complete script', () => {
  const count = (finishCounts?: Record<string, number>) => {
    const view = render(createElement(Openings, { state: { ...state, tasks: [], applications: [], openingAutofillFinishCounts: finishCounts }, selected: '', go, personal, mutate }));
    fireEvent.change(view.getByLabelText('Autofill support'), { target: { value: 'all' } });
    const button = view.getByRole('button', { name: /Generate Docs for/ });
    const result = { text: button.textContent, label: button.getAttribute('aria-label') };
    cleanup();
    return result;
  };
  assert.equal(count().text, '');
  assert.doesNotMatch(count().label || '', /to finish/);
  assert.equal(count({ [opening.id]: 0 }).text, '(0)');
  assert.match(count({ [opening.id]: 3 }).label || '', /· 3 to finish on the application/);
});

test('Opening list and detail both flag a completed package with outdated evidence', async () => {
  const run: ApplicationPreparation = { id: 'stale-run', openingId: opening.id, applicationId: application.id,
    status: 'ready', phase: 'ready', message: 'Ready', openingHash: opening.hash,
    documentIds: ['resume', 'letter'], taskIds: [], supportedForm: false,
    createdAt: '2026-10-06', updatedAt: '2026-10-06', stale: true,
    staleReasons: ['Resume evidence changed: the supporting experience dossier was updated. Prepare current documents.'] };
  const next = { ...state, tasks: [], applications: [], preparations: [run] };
  const view = render(createElement(Openings, { state: next, selected: '', go, personal, mutate }));
  fireEvent.change(view.getByLabelText('Autofill support'), { target: { value: 'all' } });
  const generate = view.getByRole('button', { name: /Generate Docs for.*Materials need attention/ });
  assert.ok(generate.querySelector('.lucide-triangle-alert'));
  assert.match(generate.title, /Saved materials need updating/);
  assert.match(generate.title, /supporting experience dossier/);
  cleanup();
  const detail = render(createElement(OpeningActions, { opening, state: next, go, mutate }));
  fireEvent.mouseEnter(detail.getByRole('button', { name: 'Application materials need attention' }));
  assert.match(detail.container.querySelector('.material-warning-summary')?.textContent || '', /Saved materials need updating/);
  assert.equal(detail.getByRole('tooltip').textContent?.includes('Saved materials need updating'), false);
  assert.match(detail.getByRole('tooltip').textContent || '', /supporting experience dossier/);
  assert.equal(detail.getByRole('tooltip').textContent?.includes('Preparation stopped'), false);
});


test('A busy preparation shows elapsed time and liveness on the line and keeps agent and phases in a disclosure', async () => {
  const previousFetch = globalThis.fetch;
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const documents = { ...task, id: 'doc-task', status: 'running' as const, model: 'claude-fable-5-1', effort: 'xhigh',
    activity: { turn: 2, toolCalls: 14, lastEventAt: ago(20), lastEvent: 'read dossier' } };
  const run: ApplicationPreparation = { id: 'busy', openingId: opening.id, applicationId: application.id, status: 'running', phase: 'documents',
    message: 'Generating the tailored resume and cover letter…', openingHash: opening.hash, documentIds: [], taskIds: [documents.id], documentTaskId: documents.id,
    supportedForm: false, createdAt: ago(1000), updatedAt: ago(750),
    phaseHistory: [{ phase: 'queued', at: ago(1000) }, { phase: 'form', at: ago(970) }, { phase: 'documents', at: ago(750) }] };
  globalThis.fetch = async input => String(input).endsWith('/preparation/activity')
    ? Response.json({ run: { id: run.id, phase: 'documents', status: 'running', updatedAt: run.updatedAt }, tasks: [{ id: documents.id, role: 'documents', status: 'running', model: documents.model, effort: documents.effort,
        live: { state: 'writing', since: ago(30), lastSignalAt: new Date().toISOString(), outputChars: 4800 } }] })
    : Response.json({ running: false, phase: 'idle', message: 'No task running' });
  const checks = (container: HTMLElement) => {
    const status = container.querySelector('[role="status"]')!;
    // The live region holds only the stable message; the ticking figures sit beside it, readable but not re-announced.
    assert.equal(status.textContent, 'Generating the tailored resume and cover letter…');
    const line = container.querySelector('.preparation-live')!;
    assert.match(line.textContent || '', /Generating the tailored resume and cover letter… · 12 min/);
    assert.doesNotMatch(line.textContent || '', /Turn 2|Fable|Documents/);
    assert.equal(status.closest('.preparation-live'), line);
    assert.equal(container.querySelectorAll('.preparation-live-detail[aria-hidden]').length, 0);
    assert.equal(container.querySelectorAll('.preparation-live-detail').length, 2);
    assert.equal(status.querySelector('.preparation-live-detail'), null);
    const details = container.querySelector('.preparation-activity-details')!;
    assert.match(details.textContent || '', /Claude Code · claude-fable-5-1 · xhigh/);
    assert.match(details.textContent || '', /Turn 2 · 14 tool calls · last event \d+ s ago: read dossier/);
    const rows = [...details.querySelectorAll('li')].map(row => row.textContent);
    assert.deepEqual(rows, ['Queued30 s', 'Form3 min', 'Documents12 min']);
    return status;
  };
  try {
    const opening_ = render(createElement(OpeningActions, { opening, mutate, go, state: { ...state, tasks: [documents], documents: [], preparations: [run] } }));
    await waitFor(() => assert.match(opening_.container.querySelector('.preparation-live')?.textContent || '', /writing, about 800 words/));
    checks(opening_.container);
    assert.equal(opening_.container.querySelector<HTMLDetailsElement>('details.preparation-activity-disclosure')?.open, false);
    cleanup();
    const line = render(createElement(PreparationStatusLine, { run, openingId: opening.id, go, tasks: [documents], runs: [run] }));
    await waitFor(() => assert.match(line.container.querySelector('.preparation-line-status')?.textContent || '', /writing, about 800 words/));
    checks(line.container);
    fireEvent.mouseEnter(line.getByRole('button', { name: 'About generation progress' }));
    assert.match(line.getByRole('tooltip').textContent || '', /quiet stretch is normal/);
  } finally { cleanup(); globalThis.fetch = previousFetch; }
});

test('Employer replies foreground positives and expose negative outcomes on request', async () => {
  const { default: GmailReplies } = await import('../gmail/GmailReplies');
  const priorFetch = globalThis.fetch;
  const reply = {
    id: 'reply-positive', messageId: 'a1', account: 'candidate@example.net', threadId: 'a2',
    sender: 'Recruiter', subject: 'Pick a time to chat', receivedAt: '2026-10-13T12:00:00Z',
    excerpt: 'Are you free for a quick chat?', kind: 'follow_up', applicationIds: [],
    reason: 'Possible employer follow-up', detectedAt: '2026-10-13T12:01:00Z',
  };
  const gmail = { configured: true, connected: true, account: reply.account,
    filterSettingsGranted: true, sendGranted: true, enabled: true, autoUpdate: true, includeNegative: true,
    checking: false, hasMore: false, checked: 0, needsNegativeBackfill: false, needsRescan: false,
    lastCheckedAt: '2026-10-13T12:01:00Z', nextCheckAt: '2026-10-13T12:16:00Z',
    replies: [reply, { ...reply, id: 'reply-negative', messageId: 'a3', kind: 'rejection', subject: 'Application decision' },
      { ...reply, id: 'reply-earlier', messageId: 'a4', receivedAt: '2020-01-01T00:00:00Z', applicationIds: [application.id], subject: 'Earlier recruiter conversation' }],
  };
  const requests: string[] = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    assert.equal(String(input), '/api/gmail');
    return Response.json(gmail);
  };
  try {
    const view = render(createElement(GmailReplies, { state, page: 'replies', go }));
    await view.findByText('Pick a time to chat');
    assert.equal(view.queryByText('Application decision'), null);
    assert.equal(view.queryByText('Earlier recruiter conversation'), null);
    assert.ok(view.getByRole('button', { name: 'About Gmail coverage' }));
    assert.equal(view.container.querySelector('details.gmail-connection-settings')?.hasAttribute('open'), false);
    fireEvent.click(view.getByLabelText('Show negative replies (1)'));
    assert.ok(view.getByText('Application decision'));
    fireEvent.click(view.getByLabelText('Show earlier replies (1)'));
    assert.ok(view.getByText('Earlier recruiter conversation'));
    assert.deepEqual(requests, ['/api/gmail']);
  } finally { cleanup(); globalThis.fetch = priorFetch; }
});

test('Gmail status distinguishes pending coverage and failures from a completed check', async () => {
  const { default: GmailScanStatus } = await import('../gmail/GmailScanStatus');
  const base = { configured: true, connected: true, filterSettingsGranted: true, sendGranted: true,
    enabled: true, autoUpdate: true, includeNegative: false, checking: false,
    hasMore: false, checked: 0, needsNegativeBackfill: false, needsRescan: false, replies: [],
    lastCheckedAt: '2026-10-13T12:00:00Z' };
  for (const [patch, expected] of [
    [{ needsRescan: true }, 'broader check of the past 90 days is pending'],
    [{ hasMore: true, checked: 100 }, 'Remaining mail will be checked automatically'],
    [{ error: 'Reconnect Gmail' }, 'Coverage is incomplete'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(GmailScanStatus, { data: { ...base, ...patch } }));
    assert.ok(html.includes(expected));
    assert.equal(html.includes('Last completed check'), false);
  }
});

test('Settings Gmail survives global search and keeps failed preference saves beside its controls', async () => {
  const priorFetch = globalThis.fetch;
  const keys = ['location', 'innerWidth', 'EventSource'] as const;
  const savedGlobals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const previousMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  class FixtureEvents { addEventListener() {} close() {} }
  for (const [key, value] of Object.entries({ location: window.location, innerWidth: 2000, EventSource: FixtureEvents })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const { setCsrf } = await import("../workspace/api");
  const gmail = { configured: true, connected: true, account: 'candidate@example.net', filterSettingsGranted: true, sendGranted: true,
    enabled: true, autoUpdate: true, includeNegative: false, checking: false, hasMore: false, checked: 0,
    needsNegativeBackfill: false, needsRescan: false, replies: [] };
  const reads: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); reads.push(url);
    if (url === '/api/state') return Response.json({ ...state, csrfToken: 'fixture-token' });
    if (url === '/api/gmail') return Response.json(gmail);
    if (url === '/api/records') return Response.json([]);
    if (url === '/api/system/reload') return Response.json({ waiting: false, reloading: false });
    if (url === '/api/gmail/settings') return Response.json({ error: 'Gmail preference save failed' }, { status: 503 });
    throw new Error(`Unexpected request: ${url}`);
  };
  window.location.hash = '#settings';
  try {
    const { App } = await import('../App');
    const view = render(createElement(App));
    const control = await view.findByLabelText('Include negative replies');
    const firstSection = view.container.querySelector('#settings-gmail');
    assert.ok(firstSection?.contains(control));
    const { settingsSections } = await import('../settings/settings-sections');
    for (const { id } of settingsSections) {
      const targets = view.container.querySelectorAll(`#${id}`);
      assert.equal(targets.length, 1);
      assert.equal(targets[0].getAttribute('tabindex'), '-1');
    }
    assert.equal(reads.filter(url => url === '/api/gmail').length, 1);
    const search = view.getByPlaceholderText('Search your workspace…');
    fireEvent.change(search, { target: { value: 'fixture' } });
    assert.ok(view.getByRole('heading', { name: 'Search the workspace' }));
    assert.equal(view.queryByLabelText('Include negative replies'), null);
    assert.equal(window.location.hash, '#settings');
    fireEvent.change(search, { target: { value: '' } });
    const restored = await view.findByLabelText('Include negative replies');
    const section = view.container.querySelector('#settings-gmail');
    assert.ok(section?.contains(restored));
    assert.notEqual(section, firstSection);
    assert.equal(view.getAllByLabelText('Include negative replies').length, 1);
    fireEvent.click(restored);
    const failure = await view.findByText('Gmail preference save failed');
    assert.ok(section?.contains(failure));
    assert.equal(failure.getAttribute('role'), 'alert');
    assert.equal((restored as HTMLInputElement).checked, false);
    assert.equal(reads.filter(url => url === '/api/gmail/settings').length, 1);
  } finally {
    cleanup(); globalThis.fetch = priorFetch; setCsrf(''); window.location.hash = '';
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (previousMedia) Object.defineProperty(window, 'matchMedia', previousMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
  }
});
