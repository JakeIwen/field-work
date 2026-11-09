import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { Application, Opening } from "../../shared/types.js";
import { GmailManager } from "../../server/gmail/manager.js";
import type { GmailMessage, GmailReader } from "../../server/gmail/api.js";
import { atomicWrite, Store } from "../../server/storage.js";

export const gmailTestAccount = "candidate@example.net";
export const gmailTestAt = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();
export const gmailTestApplication = (): Application => ({
  id: "app",
  openingId: "opening",
  company: "Acme Labs",
  title: "Senior Engineer",
  status: "applied",
  nextAction: "",
  followUp: "2026-12-01",
  contacts: "",
  notes: "Keep these notes",
  documentIds: [],
  version: 1,
  createdAt: gmailTestAt(15),
  updatedAt: gmailTestAt(10),
  submittedAt: gmailTestAt(10),
  packages: [],
});
export const gmailTestOpening = {
  id: "opening",
  company: "Acme Labs",
  title: "Senior Engineer",
} as Opening;
export const gmailTestMessage = (
  patch: Partial<GmailMessage> = {},
): GmailMessage => ({
  id: "abc123",
  threadId: "def123",
  sender: "Acme Recruiting <hiring@acme.example>",
  subject: "Senior Engineer at Acme Labs",
  text: "We would like to invite you to an interview for the Senior Engineer position at Acme Labs. Please share your availability.",
  receivedAt: gmailTestAt(3),
  authenticated: true,
  ...patch,
});

export function gmailFixture(reader: GmailReader) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-gmail-"));
  const store = new Store(root, path.join(root, ".local"));
  atomicWrite(
    path.join(store.dataDir, "gmail", "tokens.json"),
    JSON.stringify({
      account: gmailTestAccount,
      refreshToken: "private-refresh-token",
    }),
  );
  store.put("application", "app", gmailTestApplication());
  store.put("cache_opening", "opening", gmailTestOpening);
  const manager = new GmailManager(store, 4317, () => {}, reader);
  return {
    store,
    manager,
    async close() {
      await manager.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function finishGmailCheck(manager: GmailManager) {
  for (let index = 0; index < 100 && manager.state().checking; index++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.state().checking, false, "check finished");
}
