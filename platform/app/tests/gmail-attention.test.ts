import test from "node:test";
import assert from "node:assert/strict";
import type { Application } from "../shared/types.js";
import type { EmployerReply } from "../shared/gmail.js";
import { isEarlierEmployerReply } from "../shared/gmail-attention.js";

const application = {
  id: "app",
  createdAt: "2026-09-28T00:00:00Z",
  submittedAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z",
  status: "rejected",
  version: 2,
} as Application;
const reply = {
  applicationIds: ["app"],
  receivedAt: "2026-08-26T00:00:00Z",
  kind: "follow_up",
} as EmployerReply;

test("earlier correspondence is secondary while new replies after a closed decision still need attention", () => {
  assert.equal(isEarlierEmployerReply(reply, [application]), true);
  assert.equal(
    isEarlierEmployerReply({ ...reply, receivedAt: "2026-10-02T00:00:00Z" }, [
      application,
    ]),
    true,
  );
  assert.equal(
    isEarlierEmployerReply({ ...reply, receivedAt: "2026-10-12T00:00:00Z" }, [
      application,
    ]),
    false,
  );
  assert.equal(
    isEarlierEmployerReply({ ...reply, receivedAt: "2026-10-02T00:00:00Z" }, [
      { ...application, status: "applied" },
    ]),
    false,
  );
  assert.equal(
    isEarlierEmployerReply({ ...reply, kind: "rejection" }, [application]),
    false,
  );
});

test("ambiguous or missing application history cannot silently hide a reply", () => {
  assert.equal(isEarlierEmployerReply(reply, []), false);
  assert.equal(
    isEarlierEmployerReply({ ...reply, applicationIds: ["app", "missing"] }, [
      application,
    ]),
    false,
  );
  assert.equal(
    isEarlierEmployerReply({ ...reply, receivedAt: "invalid" }, [application]),
    false,
  );
  assert.equal(
    isEarlierEmployerReply(
      {
        ...reply,
        receivedAt: "2026-10-02T00:00:00Z",
        applicationIds: ["app", "active"],
      },
      [application, { ...application, id: "active", status: "applied" }],
    ),
    false,
  );
});
