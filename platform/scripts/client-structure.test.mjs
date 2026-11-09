import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { globalStyles, validateClientStructure } from "./check-client-structure.mjs";

function fixture(context) {
  const root = mkdtempSync(path.join(tmpdir(), "fieldwork-client-structure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, "app/client");
  mkdirSync(path.join(client, "styles"), { recursive: true });
  mkdirSync(path.join(client, "shell"), { recursive: true });
  writeFileSync(path.join(client, "styles.css"), `${globalStyles.map((file) => `@import "./styles/${file}";`).join("\n")}\n`);
  for (const file of globalStyles) writeFileSync(path.join(client, "styles", file), `.fixture-${file.replace(".css", "")} { display: block; }\n`);
  for (const file of ["AppPage.tsx", "ShortcutHelp.tsx", "Toast.tsx", "navigation.ts"]) writeFileSync(path.join(client, "shell", file), "export {};\n");
  writeFileSync(path.join(client, "App.tsx"), ["./shell/AppPage", "./shell/navigation", "./shell/ShortcutHelp", "./shell/Toast"].join("\n"));
  return root;
}

test("accepts the owned shell and ordered stylesheet manifest", (context) => {
  assert.deepEqual(validateClientStructure(fixture(context)), []);
});

test("keeps new modules in feature folders instead of the client root", (context) => {
  const root = fixture(context);
  const client = path.join(root, "app/client");
  mkdirSync(path.join(client, "openings"), { recursive: true });
  writeFileSync(path.join(client, "openings", "NewControl.tsx"), "export {};\n");
  assert.deepEqual(validateClientStructure(root), []);

  for (const name of ["NewControl.tsx", "lib.ts", "ui.tsx", "api.test.ts"]) {
    const stray = path.join(client, name);
    writeFileSync(stray, "export {};\n");
    assert.deepEqual(validateClientStructure(root), [
      `app/client/${name} belongs in a feature folder per AGENTS.md, not the client root`,
    ]);
    rmSync(stray);
    assert.deepEqual(validateClientStructure(root), []);
  }
});

test("rejects a color outside the palette and an unowned stylesheet", (context) => {
  const root = fixture(context);
  writeFileSync(path.join(root, "app/client/styles/stray.css"), ".stray {}\n");
  for (const color of ["#fff", "rgba(255, 0, 0, 0.5)", "hsla(0, 100%, 50%, 0.5)"]) {
    writeFileSync(path.join(root, "app/client/styles/base.css"), `.bad { color: ${color}; }\n`);
    const problems = validateClientStructure(root);
    assert.ok(problems.some((problem) => problem.includes("color literals")), color);
    assert.ok(problems.some((problem) => problem.includes("exactly the imported sheets")));
  }
});

test("rejects colors and selectors in every client stylesheet", (context) => {
  const root = fixture(context);
  const client = path.join(root, "app/client");
  mkdirSync(path.join(client, "settings"), { recursive: true });
  writeFileSync(path.join(client, "settings", "feature.css"), ".feature { color: #fff; }\n");
  writeFileSync(path.join(client, "styles-feature.css"), ".feature { color: rgb(1, 2, 3); }\n");
  writeFileSync(path.join(client, "selectors.css"), '[data-palette="x"] {}\n[data-theme="dark"] {}\n');

  const problems = validateClientStructure(root);
  assert.ok(problems.some((problem) => problem.includes("app/client/settings/feature.css defines color literals") && problem.includes("#fff")));
  assert.ok(problems.some((problem) => problem.includes("app/client/styles-feature.css defines color literals") && problem.includes("rgb(1, 2, 3)")));
  assert.ok(problems.some((problem) => problem.includes("app/client/selectors.css defines a palette selector")));
  assert.ok(problems.some((problem) => problem.includes("app/client/selectors.css defines a theme selector")));
});

test("allows literals and selectors in the theme stylesheet", (context) => {
  const root = fixture(context);
  writeFileSync(
    path.join(root, "app/client/styles-theme.css"),
    ':root[data-theme="dark"] { --color: #fff; }\n[data-palette="x"] { --color: rgb(1, 2, 3); }\n',
  );
  assert.deepEqual(validateClientStructure(root), []);
});

test("rejects a giant sheet and shell ownership drift", (context) => {
  const root = fixture(context);
  writeFileSync(path.join(root, "app/client/styles/responsive-mobile.css"), `${".rule { display: block; }\n".repeat(801)}`);
  writeFileSync(path.join(root, "app/client/App.tsx"), "./shell/AppPage\n");
  const problems = validateClientStructure(root);
  assert.ok(problems.some((problem) => problem.includes("another global stylesheet")));
  assert.ok(problems.some((problem) => problem.includes("./shell/navigation")));
});
