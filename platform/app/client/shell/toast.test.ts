import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent } = await import("../testing/test-render");
const { act } = await import("@testing-library/react");
const { Toast } = await import("./Toast");
const { useNotices } = await import("./useNotices");
import type { Go } from "../workspace/workspace-actions";

function Harness() {
  const { notices, notify, closeNotice } = useNotices();
  return createElement("div", null,
    ...["first", "second", "third", "fourth"].map(text => createElement("button", { key: text, onClick: () => notify(text) }, `Notify ${text}`)),
    createElement("div", { className: "toast-stack" }, ...notices.map(notice => createElement(Toast, { key: notice.id, notice, onClose: closeNotice, go: () => {} }))),
  );
}

test("notification stack keeps the newest three in arrival order and dismisses only the chosen notice", () => {
  const view = render(createElement(Harness));
  for (const text of ["first", "second", "third", "fourth"]) fireEvent.click(view.getByRole("button", { name: `Notify ${text}` }));
  assert.deepEqual(view.getAllByRole("status").map(status => status.textContent), ["second", "third", "fourth"]);
  fireEvent.click(view.getAllByRole("button", { name: "Dismiss notification" })[1]);
  assert.deepEqual(view.getAllByRole("status").map(status => status.textContent), ["second", "fourth"]);
});

test("each notice expires independently and another notification never resets its timer", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const view = render(createElement(Harness));
  fireEvent.click(view.getByRole("button", { name: "Notify first" }));
  act(() => context.mock.timers.tick(4000));
  fireEvent.click(view.getByRole("button", { name: "Notify second" }));
  act(() => context.mock.timers.tick(5000));
  assert.deepEqual(view.getAllByRole("status").map(status => status.textContent), ["second"]);
  act(() => context.mock.timers.tick(4000));
  assert.equal(view.queryByRole("status"), null);
});

test("hover and focus pause only their notice and Escape consumes dismissal", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const view = render(createElement(Harness));
  fireEvent.click(view.getByRole("button", { name: "Notify first" }));
  fireEvent.click(view.getByRole("button", { name: "Notify second" }));
  const first = view.getAllByRole("status")[0];
  fireEvent.mouseEnter(first);
  act(() => context.mock.timers.tick(9000));
  assert.deepEqual(view.getAllByRole("status").map(status => status.textContent), ["first"]);
  const close = view.getByRole("button", { name: "Dismiss notification" });
  fireEvent.focus(close);
  fireEvent.mouseLeave(first);
  act(() => context.mock.timers.tick(9000));
  assert.ok(view.getByRole("status"));
  fireEvent.blur(close, { relatedTarget: document.body });
  act(() => context.mock.timers.tick(4499));
  assert.ok(view.getByRole("status"));
  let escaped = false;
  const escape = () => { escaped = true; };
  document.addEventListener("keydown", escape);
  try {
    fireEvent.keyDown(close, { key: "Escape" });
    assert.equal(view.queryByRole("status"), null);
    assert.equal(escaped, false);
  } finally { document.removeEventListener("keydown", escape); }
});

test("structured notifications render linked sentences, stopped icons and native modified link gestures", () => {
  const navigations: [string, string | undefined][] = [];
  const go: Go = (page, id) => { navigations.push([page, id]); };
  const view = render(createElement(Toast, {
    notice: { id: 1, text: "Generate Docs stopped: ", tone: "attention",
      links: [{ label: "Acme — Engineer", page: "openings", id: "role/with spaces", detail: "App reloaded." }],
      suffix: " · 0 of 8 running, 2 queued" },
    go, onClose: () => {},
  }));
  assert.equal(view.getByRole("status").textContent, "Generate Docs stopped: Acme — Engineer — App reloaded. · 0 of 8 running, 2 queued");
  assert.ok(view.container.querySelector(".lucide-triangle-alert"));
  assert.equal(view.container.querySelector(".lucide-check"), null);
  const link = view.getByRole("link", { name: "Acme — Engineer" });
  assert.equal(link.getAttribute("href"), "#openings/role%2Fwith%20spaces");
  for (const options of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) fireEvent.click(link, options);
  assert.deepEqual(navigations, []);
  fireEvent.click(link);
  assert.deepEqual(navigations, [["openings", "role/with spaces"]]);
});

test("coalesced notifications show individual event links and remaining count below their summary", () => {
  const view = render(createElement(Toast, {
    notice: { id: 1, text: "Generate Docs: 2 started, 2 finished · 2 of 8 running",
      links: [{ label: "Acme — Engineer", page: "openings", id: "acme", detail: "started" },
        { label: "Other — Engineer", page: "openings", id: "other", detail: "finished" },
        { label: "Third — Engineer", page: "openings", id: "third", detail: "started" }], more: 1 },
    go: () => {}, onClose: () => {},
  }));
  assert.equal(view.getAllByRole("link").length, 3);
  assert.deepEqual(view.getAllByRole("listitem").map(item => item.textContent), [
    "Acme — Engineer · started", "Other — Engineer · finished", "Third — Engineer · started", "and 1 more",
  ]);
  assert.ok(view.container.querySelector(".lucide-check"));
});
