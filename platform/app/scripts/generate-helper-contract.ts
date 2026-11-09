import { buildSync } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const contractStart = "  // BEGIN GENERATED HELPER CONTRACT";
export const contractEnd = "  // END GENERATED HELPER CONTRACT";

// Each binding names a preserved provider policy, rather than flags interpreted
// by one universal validator. esbuild includes only that provider's functions.
const bindings = {
  greenhouse: [
    "normalizeGreenhouseLabel as normalize",
    "validGreenhouseAttachment as validAttachment",
    "hasPdfMagic",
  ],
} as const;
export type HelperProvider = keyof typeof bindings;
export const helperProviders = Object.keys(bindings) as HelperProvider[];

export function helperFile(provider: HelperProvider) {
  return path.join(root, "automation", provider, "console-helper.js");
}

// ESM bundling tree-shakes unused provider checks without generating a module
// runtime. Replace its final export declaration with a plain returned object.
function standaloneContract(compiled: string) {
  const source = ts.createSourceFile(
    "contract.js",
    compiled,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const last = source.statements.at(-1);
  if (
    !last ||
    !ts.isExportDeclaration(last) ||
    last.moduleSpecifier ||
    !last.exportClause ||
    !ts.isNamedExports(last.exportClause) ||
    source.statements
      .slice(0, -1)
      .some(
        (node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node),
      )
  ) {
    throw new Error(
      "Expected a self-contained contract with one final named export",
    );
  }
  const properties = last.exportClause.elements.map((element) =>
    element.propertyName
      ? `${element.name.text}: ${element.propertyName.text}`
      : element.name.text,
  );
  return (
    compiled.slice(0, last.getFullStart()).trimEnd() +
    `\nreturn { ${properties.join(", ")} };`
  );
}

export function renderContractBlock(provider: HelperProvider) {
  const exports = [...bindings[provider], "digest", "decodeBase64"];
  const compiled = buildSync({
    stdin: {
      contents: `export { ${exports.join(", ")} } from "./helper-contract.ts";`,
      resolveDir: path.join(root, "platform/app/scripts"),
      sourcefile: "helper-contract-entry.ts",
      loader: "ts",
    },
    absWorkingDir: root,
    bundle: true,
    treeShaking: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "none",
  }).outputFiles[0].text.trimEnd();
  const binding = "const helperContract = ";
  const terminator = ";";
  const body = standaloneContract(compiled)
    .split("\n")
    .map((line) => (line ? `    ${line}` : ""))
    .join("\n");
  return `${contractStart}\n  ${binding}(() => {\n${body}\n  })()${terminator}\n${contractEnd}`;
}

export function generatedHelper(provider: HelperProvider, source: string) {
  const start = source.indexOf(contractStart);
  const end = source.indexOf(contractEnd);
  if (
    start < 0 ||
    end < start ||
    source.indexOf(contractStart, start + 1) !== -1 ||
    source.indexOf(contractEnd, end + 1) !== -1
  ) {
    throw new Error(
      `Expected one generated contract block in ${helperFile(provider)}`,
    );
  }
  return (
    source.slice(0, start) +
    renderContractBlock(provider) +
    source.slice(end + contractEnd.length)
  );
}

export function generateHelperContracts() {
  for (const provider of helperProviders) {
    const file = helperFile(provider);
    const source = readFileSync(file, "utf8");
    const generated = generatedHelper(provider, source);
    if (generated !== source) writeFileSync(file, generated);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  generateHelperContracts();
}
