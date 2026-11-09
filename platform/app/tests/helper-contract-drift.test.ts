import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  contractStart,
  generatedHelper,
  helperFile,
  helperProviders,
  renderContractBlock,
} from "../scripts/generate-helper-contract.js";

for (const provider of helperProviders) {
  test(`${provider} standalone helper contract is generated and syntactically valid`, () => {
    const file = helperFile(provider);
    const source = readFileSync(file, "utf8");
    assert.equal(
      generatedHelper(provider, source),
      source,
      "Run npm --prefix platform run helpers:generate",
    );
    assert.doesNotMatch(
      renderContractBlock(provider),
      /\b(?:__defProp|__getOwnPropDesc|__getOwnPropNames|__hasOwnProp|__copyProps|__toCommonJS|__export|require|import|export)\b/,
      "Generated checks must be plain self-contained JavaScript, not a module runtime",
    );
    execFileSync(process.execPath, ["--check", file]);
  });
}

test("helper generator rejects missing or ambiguous contract markers", () => {
  const provider = helperProviders[0];
  const source = readFileSync(helperFile(provider), "utf8");
  assert.throws(
    () => generatedHelper(provider, ""),
    /Expected one generated contract block/,
  );
  assert.throws(
    () => generatedHelper(provider, source + contractStart),
    /Expected one generated contract block/,
  );
});
