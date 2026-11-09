import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, dom } = await import("../testing/test-render");
const { useState } = await import("react");
const { MultiSelect } = await import("./MultiSelect");

function Harness() {
  const [value, onChange] = useState<string[]>([]);
  return createElement(MultiSelect, {
    label: "Technical fit", emptyLabel: "Any technical fit", value, onChange,
    options: ["High", "Medium", "Low"],
  });
}

test("checkbox dropdown adds and removes values without closing, summarizes and clears", () => {
  const view = render(createElement(Harness));
  const trigger = view.getByRole("button", { name: "Technical fit" });
  assert.equal(trigger.textContent, "Any technical fit");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  fireEvent.click(trigger);
  const popup = view.getByRole("dialog", { name: "Technical fit" });
  assert.equal(trigger.getAttribute("aria-controls"), popup.id);
  const high = view.getByRole("checkbox", { name: "High" }) as HTMLInputElement;
  assert.equal(dom.window.document.activeElement, high);
  fireEvent.click(high);
  fireEvent.click(view.getByRole("checkbox", { name: "Medium" }));
  assert.equal(trigger.textContent, "High, Medium");
  assert.equal(high.checked, true);
  assert.equal(view.getByRole("dialog"), popup);
  fireEvent.click(view.getByRole("checkbox", { name: "Low" }));
  assert.equal(trigger.textContent, "3 selected");
  fireEvent.click(high);
  assert.equal(high.checked, false);
  assert.equal(trigger.textContent, "Medium, Low");
  fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
  assert.equal(trigger.textContent, "Any technical fit");
  assert.ok(view.getAllByRole("checkbox").every(input => !(input as HTMLInputElement).checked));
});

test("ArrowDown opens, Escape is consumed and focus returns to the labelled trigger", () => {
  const view = render(createElement(Harness));
  const trigger = view.getByRole("button", { name: "Technical fit" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  let escaped = false;
  const ancestor = () => { escaped = true; };
  document.addEventListener("keydown", ancestor);
  try {
    const event = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(view.getByRole("checkbox", { name: "High" }), event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(escaped, false);
    assert.equal(view.queryByRole("dialog"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally { document.removeEventListener("keydown", ancestor); }
});

test("outside pointer and keyboard focus departure dismiss without trapping focus", () => {
  const view = render(createElement(Harness));
  const trigger = view.getByRole("button", { name: "Technical fit" });
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  assert.equal(view.queryByRole("dialog"), null);
  fireEvent.click(trigger);
  fireEvent.blur(view.getByRole("checkbox", { name: "Low" }), { relatedTarget: document.body });
  assert.equal(view.queryByRole("dialog"), null);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  assert.equal(view.queryByRole("dialog"), null);
});
