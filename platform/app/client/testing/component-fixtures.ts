import type { AutofillRecord } from "../../shared/greenhouse-autofill";
import type { AppState, Application, Opening, TaskSummary, Document } from '../../shared/types';

export const application: Application = {
  id: 'application-fixture', openingId: 'opening-fixture', status: 'interviewing',
  nextAction: 'Confirm interview', followUp: '2026-10-06', contacts: 'Recruiter',
  notes: 'Discuss on-call', documentIds: [], version: 4,
  createdAt: '2026-09-28T12:00:00Z', updatedAt: '2026-09-29T12:00:00Z',
  submittedAt: '2026-09-29T12:00:00Z',
};
export const opening: Opening = {
  id: application.openingId, company_id: 'company-fixture', company: 'Fixture Company',
  job_id: '123', title: 'Senior Engineer', url: 'https://example.test/jobs/123',
  technical_fit: 'High', remote_fit: 'Medium', wlb_outlook: 'Uncertain',
  location: 'US remote', compensation: 'Location-based pay bands', why: 'Full-stack work',
  concerns: 'Travel rules unknown', requirements: 'React and Node.js', wlb_evidence: 'Not established',
  status: 'NEW', first_seen: '2026-09-28', last_confirmed_open: '2026-09-29',
  postingStatus: 'open', sourcePath: 'fixture/opening.md', sourceDate: '2026-09-29', hash: 'fixture-hash',
};
export const approval = {
  requestId: 'request-fixture', threadId: 'thread-fixture',
  method: 'item/commandExecution/requestApproval', params: { reason: 'Inspect the fixture files' },
};
export const task: TaskSummary = {
  id: 'task-fixture', preset: 'job-fit', status: 'waiting for approval', mode: 'live',
  version: 2, eventCount: 3, title: 'Review the opening', prompt: 'Review this role',
  context: { documentIds: [], openingId: opening.id }, threadId: approval.threadId,
  createdAt: '2026-09-29T12:00:00Z', updatedAt: '2026-09-29T12:01:00Z',
  model: 'fixture-model', effort: 'high',
  messages: [
    { id: 'user-message', role: 'user', text: 'Review [the role](https://example.test/jobs/123).', at: '2026-09-29T12:00:00Z' },
    { id: 'answer-message', role: 'assistant', text: '**Relevant experience**\n\nReview [the evidence](fixture/evidence.md).', at: '2026-09-29T12:01:00Z', delivery: 'queued' },
  ],
  pendingRequests: [approval], manifest: { paths: ['fixture/evidence.md'], sourceHashes: {} },
};
export const questionTask: TaskSummary = { ...task, id: 'question-fixture', preset: 'questions', status: 'completed' };
export const state: AppState = {
  companies: [], openings: [opening], documents: [], applications: [application], tasks: [task, questionTask],
  personal: {}, journal: [], settings: { timezone: 'UTC' }, savedFilters: [], health: [],
  scan: { timestamp: null, seenCount: 0, failedCompanies: [] }, sourceHashes: {}, validSections: {}, importedAt: null,
};
export const connectedStatus = { available: true, pendingRequests: [approval] };
export const questionContext = {
  available: true, reference: { title: 'Fixture reference', messages: 2 }, sources: [],
};

export const resumeDocument: Document = {
  id: 'resume', logicalId: 'resume', name: 'resume.pdf', path: 'fixture/resume.pdf', hash: 'resume-hash',
  kind: 'resume', scope: 'tailored', company: opening.company, openingId: opening.id,
  version: 'v1', versionNumber: 1, status: 'draft', privacy: 'private', format: 'pdf',
  authoredDate: '2026-10-06', dateProvenance: 'Fixture', modifiedAt: '2026-10-06', createdAt: '2026-10-06',
  text: 'Fixture resume', validation: 'passed', generatedBy: 'doc-task',
};
export const coverLetterDocument: Document = {
  ...resumeDocument, id: 'cover-letter', logicalId: 'cover-letter', kind: 'cover-letter',
  name: 'cover-letter.pdf', path: 'fixture/cover-letter.pdf', hash: 'cover-letter-hash', text: 'Fixture letter',
};
export const autofill: AutofillRecord = {
  id: 'script', openingId: opening.id, version: 1, createdAt: '2026-10-06T12:00:00Z',
  url: 'https://job-boards.greenhouse.io/example/jobs/123', title: opening.title,
  openingHash: opening.hash, sourceHash: 'form', profileHash: 'profile', helperHash: 'helper', scriptHash: 'script-hash', evidenceHash: 'evidence',
  answers: [], review: [],
};
