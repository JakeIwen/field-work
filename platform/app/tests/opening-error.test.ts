import test from "node:test";
import assert from "node:assert/strict";
import { openingErrorMessage } from "../shared/opening-error.js";

test("errors identify company and role without repeating context from the server", () => {
  const opening = { company: "Example", title: "Software Engineer" };
  const message = openingErrorMessage(
    opening,
    new Error("Could not load the form."),
  );
  assert.equal(
    message,
    "Example · Software Engineer: Could not load the form.",
  );
  assert.equal(openingErrorMessage(opening, message), message);
  assert.equal(
    openingErrorMessage({ id: "opening-123" }, "Not found"),
    "opening-123: Not found",
  );
  assert.equal(openingErrorMessage(undefined, new Error("Offline")), "Offline");
});
