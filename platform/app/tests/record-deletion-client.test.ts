import test from "node:test";
import assert from "node:assert/strict";
import {
  dom,
  createElement,
  render,
  fireEvent,
  waitFor,
} from "../client/testing/test-render.js";
import type { WorkspaceValue } from "../client/workspace/workspace.js";
import { state } from "../client/testing/component-fixtures.js";

const { default: DeleteRecord } = await import("../client/ui/DeleteRecord.js");
const { WorkspaceProvider } = await import("../client/workspace/workspace.js");
const { setCsrf } = await import("../client/workspace/api.js");
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};

test("successful DELETE closes and notifies without awaiting or replaying a state refresh", async () => {
  setCsrf("fixture-token");
  const calls: string[] = [],
    notifications: string[] = [];
  let deleted = 0,
    mutations = 0;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    return Response.json({
      token: "preview",
      records: [{ kind: "journal", id: "entry", title: "Entry" }],
      files: [],
      updatedRecords: [],
      editedFiles: [],
      sharedFiles: 0,
    });
  };
  const value: WorkspaceValue = {
    state,
    selected: "",
    go: () => {},
    personal: async () => {},
    agent: () => {},
    mutate: async () => {
      mutations++;
      throw new Error("State refresh failed");
    },
    notify: (message: string) => notifications.push(message),
  };
  const view = render(
    createElement(WorkspaceProvider, {
      value,
      children: createElement(DeleteRecord, {
        kind: "journal",
        id: "entry",
        label: "Entry",
        onDeleted: () => {
          deleted++;
        },
      }),
    }),
  );
  fireEvent.click(view.getByLabelText("Delete Entry"));
  await view.findByText("Review everything being deleted");
  fireEvent.click(view.getByText("Permanently delete"));
  await waitFor(() => assert.equal(deleted, 1));
  assert.equal(view.queryByRole("dialog"), null);
  assert.deepEqual(notifications, ["Deleted Entry"]);
  assert.equal(mutations, 0);
  assert.deepEqual(calls, [
    "GET /api/records/journal/entry/deletion",
    "DELETE /api/records/journal/entry",
  ]);
});
