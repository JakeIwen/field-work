import test from "node:test";
import assert from "node:assert/strict";
import type { Application, Opening } from "../shared/types.js";
import type { GmailMessage } from "../server/gmail/api.js";
import {
  gmailContextApplicationIds,
  matchEmployerReply,
  needsGmailThreadContext,
} from "../server/gmail/matching.js";

const account = "candidate@example.net";
const opening = {
  id: "opening",
  company: "Acme Labs",
  title: "Senior Engineer",
} as Opening;
const application = {
  id: "app",
  openingId: opening.id,
  company: opening.company,
  title: opening.title,
  contacts: "Rae Recruiter <rae@acme.example>",
} as Application;
const message = (patch: Partial<GmailMessage> = {}): GmailMessage => ({
  id: "abc",
  threadId: "thread",
  sender: "Rae <rae@acme.example>",
  subject: "Re: application",
  receivedAt: "2026-10-12T12:00:00Z",
  text: "I'd like to continue our conversation. When are you available?",
  authenticated: true,
  ...patch,
});
const match = (
  patch: Partial<GmailMessage> = {},
  context?: { applicationIds: string[] },
) =>
  matchEmployerReply(
    message(patch),
    account,
    [application],
    [opening],
    false,
    context,
  );

test("casual recruiter scheduling and calendar replies surface for review without automatic updates", () => {
  for (const text of [
    "I'd like to continue our conversation. When are you available?",
    "We liked your application. Are you free for a quick chat this week?",
    "Please send a few times that work for you to speak with our hiring manager.",
    "Tuesday works. I sent you a calendar invite.",
    "Looking forward to speaking with you next week.",
    "Let's chat about the role. Which times work best?",
    "We have a few questions about your application before the next step.",
  ]) {
    const result = match({ text });
    assert.equal(result?.reply.kind, "follow_up", text);
    assert.equal(result?.certainApplicationId, undefined, text);
  }
});

test("an interview-thread scheduling link is recognized through context", () => {
  const result = match(
    {
      sender: "Recruiter <person@agency.example>",
      subject: "Re: Senior Engineer interview",
      text: "Tuesday works. Please use this link to pick a time.",
    },
    { applicationIds: [application.id] },
  );
  assert.equal(result?.reply.kind, "follow_up");
  assert.deepEqual(result?.reply.applicationIds, [application.id]);
  assert.equal(result?.certainApplicationId, undefined);
});

test("a plain interview calendar invitation is review-only", () => {
  const result = match({
    sender: "Calendar <calendar-notification@calendar.example>",
    subject: "Invitation: Interview with Acme Labs — Senior Engineer",
    text: "Tuesday, October 20, 2:00 PM–2:30 PM\nJoin video meeting: https://meet.example/event",
  });
  assert.equal(result?.reply.kind, "interview");
  assert.deepEqual(result?.reply.applicationIds, [application.id]);
  assert.equal(result?.certainApplicationId, undefined);
});

test("company webinar invitations are not treated as employer replies", () => {
  assert.equal(
    match({
      sender: "Acme Labs Events <events@acme.example>",
      subject: "Invitation: Interview skills webinar — Senior Engineer",
      text: "Join our newsletter community webinar on interviewing. Unsubscribe",
    }),
    null,
  );
});

test("thread context associates a short employer follow-up but never makes it certain", () => {
  const result = match(
    {
      sender: "Recruiter <person@agency.example>",
      text: "I sent the calendar invite.",
    },
    { applicationIds: [application.id] },
  );
  assert.deepEqual(result?.reply.applicationIds, [application.id]);
  assert.equal(result?.reply.kind, "follow_up");
  assert.equal(result?.certainApplicationId, undefined);
});

test("a unique exact role can correlate a generic ATS invitation for review", () => {
  const result = match({
    sender: "Recruiting <notifications@ats.example>",
    subject: "Senior Engineer interview",
    text: "Please schedule your interview for the Senior Engineer position.",
  });
  assert.deepEqual(result?.reply.applicationIds, [application.id]);
  assert.equal(result?.reply.kind, "interview");
  assert.equal(result?.certainApplicationId, undefined);
});

test("an unsubscribe footer does not hide a legitimate ATS invitation", () => {
  const result = match({
    sender: "Recruiting <notifications@ats.example>",
    subject: "Senior Engineer interview",
    text: "Please schedule your interview for the Senior Engineer position.\nManage email preferences · Unsubscribe",
    listUnsubscribe: true,
    automated: true,
  });
  assert.equal(result?.reply.kind, "interview");
  assert.deepEqual(result?.reply.applicationIds, [application.id]);
});

test("an application receipt's optimistic language is not a follow-up", () => {
  for (const acknowledgement of ["Thanks", "Thank you"]) {
    assert.equal(
      match({
        sender: "Hiring <notifications@ats.example>",
        subject: `${acknowledgement} for applying to Example Corp`,
        text: `${acknowledgement} for applying to our Senior Engineer position and expressing interest in Example Corp! We’ve received your application, and we’re looking forward to finding out if you’d be the perfect person for the position. We promise to carefully review what you shared and give you an update on whether your application is a match.`,
      }),
      null,
      acknowledgement,
    );
  }
});

test("a clear invitation remains detectable after receipt language", () => {
  const result = match({
    subject: "Senior Engineer at Acme Labs",
    text: "Thanks for applying. We’d like to schedule an interview for the Senior Engineer role at Acme Labs.",
  });
  assert.equal(result?.reply.kind, "interview");
  assert.equal(result?.certainApplicationId, "app");
});

test("an actionable scheduling request survives a receipt introduction", () => {
  for (const text of [
    "Thanks for applying. Are you free for a quick chat tomorrow?",
    "Thank you for your application. Please send a few times to speak with our hiring manager.",
  ]) {
    const result = match({
      subject: "Senior Engineer at Acme Labs",
      text,
    });
    assert.equal(result?.reply.kind, "follow_up", text);
    assert.equal(result?.certainApplicationId, undefined, text);
  }
});

test("company named only in the sender associates for review, not automatic update", () => {
  const result = match({
    sender: "Acme Labs Recruiting <hiring@agency.example>",
    subject: "Interview availability",
    text: "Please send a few times that work for you to speak with our hiring manager.",
  });
  assert.deepEqual(result?.reply.applicationIds, [application.id]);
  assert.equal(result?.certainApplicationId, undefined);
});

test("receipts establish conservative thread context from company and role or an exact contact", () => {
  assert.deepEqual(
    gmailContextApplicationIds(
      message({
        sender: "no-reply@ats.example",
        subject: "Acme Labs — Senior Engineer",
        text: "Thank you for applying. Your application was received.",
      }),
      account,
      [application],
      [opening],
    ),
    [application.id],
  );
  assert.deepEqual(
    gmailContextApplicationIds(
      message({
        subject: "Application received",
        text: "Thank you for applying.",
      }),
      account,
      [application],
      [opening],
    ),
    [application.id],
  );
  assert.deepEqual(
    gmailContextApplicationIds(
      message({
        sender: "unknown@ats.example",
        subject: "Application received",
        text: "Thank you for applying.",
      }),
      account,
      [application],
      [opening],
    ),
    [],
  );
});

test("bulk, conditional, sales, receipts and quoted old invitations remain suppressed", () => {
  for (const text of [
    "Job alert: Senior Engineer at Acme Labs. View all jobs. Unsubscribe.",
    "Book a product demo and learn about next steps for Senior Engineer at Acme Labs.",
    "Thank you for applying. We may contact you to schedule an interview.",
    "If selected, we will invite you to interview for Senior Engineer at Acme Labs.",
    "Thanks for the update.\nOn Monday Recruiter wrote:\nPlease schedule your interview for Senior Engineer at Acme Labs.",
  ])
    assert.equal(match({ text }), null, text);
});

test("only plausible personal recruiting messages request thread context", () => {
  assert.equal(needsGmailThreadContext(message()), true);
  assert.equal(
    needsGmailThreadContext(message({ authenticated: false })),
    false,
  );
  assert.equal(
    needsGmailThreadContext(message({ sender: "no-reply@ats.example" })),
    true,
  );
  assert.equal(
    needsGmailThreadContext(message({ listUnsubscribe: true })),
    true,
  );
  assert.equal(
    needsGmailThreadContext(
      message({
        sender: "no-reply@ats.example",
        text: "Thank you for applying. Your application was received.",
      }),
    ),
    false,
  );
  assert.equal(
    needsGmailThreadContext(message({ text: "Can we book a product demo?" })),
    false,
  );
});
