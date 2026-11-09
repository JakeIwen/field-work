import test from "node:test";
import assert from "node:assert/strict";
import { classifyNegativeReply } from "../server/gmail/rejections.js";
import { matchEmployerReply } from "../server/gmail/matching.js";
import type { Application, Opening } from "../shared/types.js";
import type { GmailMessage } from "../server/gmail/api.js";

test("explicit negative decisions differ from pauses, closed roles and hypothetical rejection", () => {
  for (const text of [
    "Unfortunately, we will not be moving forward with your application.",
    "We've decided to move forward with other candidates. If you have questions, please contact us.",
    "We have decided not to move forward. Thank you for applying.",
    "Thank you for applying to our open Senior Analytics Engineer role at Example Corp. After careful consideration, we’ve made the difficult decision to move forward with other candidates whose skills and experiences are more closely aligned with what our team is looking for at this time.",
    "Your application was unsuccessful.",
    "We are no longer considering your application.",
  ])
    assert.deepEqual(
      classifyNegativeReply(text),
      { kind: "rejection", clear: true },
      text,
    );
  for (const text of [
    "If we decide not to move forward, we will contact you.",
    "We have not made a decision on your application.",
    "We are considering other candidates, but please share your interview availability.",
    "We have chosen to interview you alongside other candidates.",
    "We have decided not to pursue other candidates while we interview you.",
    "Your interview has been cancelled. Please reschedule for next week.",
    "This is not a rejection. Your application is still under consideration.",
  ])
    assert.equal(classifyNegativeReply(text), null, text);
  for (const text of [
    "The position has been filled.",
    "Hiring is paused.",
    "The offer has been rescinded.",
    "We have decided to pursue other candidates for this role, but invite you to an interview for a different role.",
  ])
    assert.equal(classifyNegativeReply(text)?.clear, false, text);
});

test("negative replies are optional and use the same authenticated unique-role matching and quote guards", () => {
  const opening = {
    id: "opening",
    company: "Acme Labs",
    title: "Senior Engineer",
  } as Opening;
  const application = {
    id: "app",
    openingId: opening.id,
    contacts: "",
  } as Application;
  const message: GmailMessage = {
    id: "abc",
    threadId: "def",
    sender: "Recruiter <hr@acme.example>",
    subject: "Your application for Senior Engineer at Acme Labs",
    receivedAt: "2026-10-05T12:00:00Z",
    authenticated: true,
    text: "Thank you for applying. Unfortunately, we will not be moving forward with your application.",
  };
  const match = (
    patch: Partial<GmailMessage> = {},
    apps = [application],
    include = true,
  ) =>
    matchEmployerReply(
      { ...message, ...patch },
      "candidate@example.net",
      apps,
      [opening],
      include,
    );
  assert.equal(match({}, undefined, false), null);
  assert.equal(match()?.reply.kind, "rejection");
  assert.equal(match()?.certainApplicationId, "app");
  assert.equal(
    match({ authenticated: false })?.certainApplicationId,
    undefined,
  );
  assert.equal(
    match({}, [application, { ...application, id: "another" }])
      ?.certainApplicationId,
    undefined,
  );
  assert.equal(
    match({ subject: "Acme Labs application update" })?.certainApplicationId,
    undefined,
  );
  assert.equal(match({ sender: "candidate@example.net" }), null);
  assert.equal(
    match({
      text: "Thanks for the update.\nOn Monday Recruiter wrote:\nWe will not be moving forward with your application.",
    }),
    null,
  );
  assert.equal(
    match({
      text: "Hiring is on hold for the Senior Engineer role at Acme Labs.",
    })?.reply.kind,
    "negative",
  );
  assert.equal(
    match({
      text: "Hiring is on hold for the Senior Engineer role at Acme Labs.",
    })?.certainApplicationId,
    undefined,
  );
});

test("a negative reply cannot associate by generic exact role alone", () => {
  const opening = {
    id: "opening",
    company: "Acme Labs",
    title: "Senior Engineer",
  } as Opening;
  const application = {
    id: "app",
    openingId: opening.id,
    contacts: "",
  } as Application;
  const result = matchEmployerReply(
    {
      id: "abc",
      threadId: "def",
      sender: "Unknown Hiring <hr@other.example>",
      subject: "Senior Engineer application update",
      receivedAt: "2026-10-05T12:00:00Z",
      authenticated: true,
      text: "Unfortunately, we will not be moving forward with your application.",
    },
    "candidate@example.net",
    [application],
    [opening],
    true,
  );
  assert.equal(result, null);
});
