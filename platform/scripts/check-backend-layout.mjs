import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const families = {
  autofill: [
    "attachments.ts",
    "declarations.ts",
    "employee-connections.ts",
    "profile-answers.ts",
    "question-policy.ts",
    "residence.ts",
    "resume-facts.ts",
    "salary.ts",
    "validity.ts",
  ],
  gmail: [
    "api.ts",
    "auth.ts",
    "errors.ts",
    "manager.ts",
    "matching.ts",
    "mime.ts",
    "positive.ts",
    "rejections.ts",
    "scan.ts",
    "send.ts",
  ],
  "claude-code": [
    "agent.ts",
    "approvals.ts",
    "models.ts",
    "session.ts",
    "threads.ts",
    "tools.ts",
    "turn.ts",
  ],
  careers: [
    "browser.ts",
    "http.ts",
    "monitored.ts",
    "provider-payloads.ts",
    "providers.ts",
    "reconcile.ts",
    "scan-records.ts",
    "scans.ts",
    "model.ts",
  ],
  "opening-pull": [
    "contract.ts",
    "dates.ts",
    "identity.ts",
    "publication.ts",
    "research.ts",
    "screen.ts",
    "state.ts",
  ],
};

export const contractTargets = [
  "platform/app/server/index.ts",
  "platform/app/scripts/backup-verify.ts",
  "platform/app/scripts/backup.ts",
  "platform/app/scripts/browser-check.ts",
  "platform/app/scripts/browser-refactor-fixture.ts",
  "platform/app/scripts/generate-helper-contract.ts",
  "platform/app/scripts/import.ts",
  "platform/app/scripts/probe-codex.ts",
  "platform/app/scripts/service.ts",
  "platform/app/scripts/stop.ts",
  "platform/app/scripts/verify-release.ts",
  "platform/deploy/live.sh",
  "platform/scripts/check-client-structure.mjs",
  "platform/scripts/check-backend-layout.mjs",
  "platform/scripts/check.mjs",
];

const pureRules = [
  "autofill/declarations.ts",
  "autofill/employee-connections.ts",
  "autofill/residence.ts",
  "autofill/resume-facts.ts",
  "gmail/positive.ts",
  "gmail/rejections.ts",
  "careers/provider-payloads.ts",
  "careers/model.ts",
  "opening-pull/contract.ts",
];

function contracts(markdown) {
  const after = markdown.split(/^## Contracts\s*$/m)[1] ?? "";
  const section = after.split(/^## /m)[0];
  return section
    .split("\n")
    .filter((line) => /^\|/.test(line) && !/^\|\s*(?:Path|-)/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll("`", "")),
    )
    .filter((row) => row.length >= 3);
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(target)
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [target]
        : [];
  });
}

function loadTypescript(root, typescriptRoot) {
  const base = typescriptRoot ?? root;
  const manifest = existsSync(path.join(base, "platform/package.json"))
    ? path.join(base, "platform/package.json")
    : path.join(base, "package.json");
  const require = createRequire(manifest);
  return require("typescript");
}

function imports(ts, file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  function visit(node) {
    let literal,
      typeOnly = false;
    if (ts.isImportDeclaration(node)) {
      literal = node.moduleSpecifier;
      const clause = node.importClause;
      const named =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : [];
      typeOnly = Boolean(
        clause?.isTypeOnly ||
        (named.length &&
          !clause?.name &&
          named.every((item) => item.isTypeOnly)),
      );
    } else if (ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
      typeOnly = node.isTypeOnly;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteral(literal))
      found.push({ specifier: literal.text, typeOnly });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function resolveRelative(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(
    path.dirname(importer),
    specifier.replace(/\.js$/, ""),
  );
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ])
    if (existsSync(candidate)) return candidate;
  return base;
}

function checkContracts(root, problems) {
  const rows = contracts(readFileSync(path.join(root, "AGENTS.md"), "utf8"));
  const byPath = new Map(
    rows.map(([target, caller, owner]) => [target, { caller, owner }]),
  );
  for (const target of new Set([...contractTargets, ...byPath.keys()])) {
    const row = byPath.get(target);
    if (!row) problems.push(`Contracts table is missing ${target}`);
    else {
      if (!row.caller) problems.push(`Contracts row ${target} has no caller`);
      if (!row.owner) problems.push(`Contracts row ${target} has no owner`);
      if (!existsSync(path.join(root, target)))
        problems.push(`Declared target does not exist: ${target}`);
      for (const owner of row.owner.split(/,\s*/))
        if (!existsSync(path.join(root, owner)))
          problems.push(`Contract owner does not exist: ${owner}`);
    }
  }

  const packageFile = path.join(root, "platform/package.json");
  if (existsSync(packageFile)) {
    const scripts = JSON.parse(readFileSync(packageFile, "utf8")).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (name.startsWith("test")) continue;
      for (const [, target] of command.matchAll(
        /\b(?:node|tsx|bash) ([\w./-]+\.(?:mjs|ts|sh))/g,
      )) {
        const relative = `platform/${target}`;
        if (!byPath.has(relative))
          problems.push(
            `Package command ${name} has undeclared target: ${relative}`,
          );
      }
    }
  }
}

function checkEntry(ts, server, problems) {
  const entry = path.join(server, "index.ts");
  for (const item of imports(ts, entry))
    if (
      [
        "autofill",
        "gmail",
        "claude-code",
        "careers",
        "opening-pull",
        "routes",
      ].some(
        (name) =>
          item.specifier.includes(`/${name}/`) ||
          item.specifier === `./${name}`,
      )
    )
      problems.push(
        `server entry imports feature implementation: ${item.specifier}`,
      );
}

function checkFeatureFolders(server, problems) {
  for (const [family, expected] of Object.entries(families)) {
    const directory = path.join(server, family);
    for (const file of expected)
      if (!existsSync(path.join(directory, file)))
        problems.push(`${family} feature is missing ${file}`);
    for (const entry of readdirSync(server))
      if (entry.startsWith(`${family}-`) && entry.endsWith(".ts"))
        problems.push(`${family} ownership regressed to flat file ${entry}`);
  }
}

function checkClientDependencies(ts, root, server, client, problems) {
  const familyRoots = Object.keys(families).map(
    (family) => path.join(server, family) + path.sep,
  );
  for (const file of sourceFiles(client))
    for (const item of imports(ts, file)) {
      const target = resolveRelative(file, item.specifier);
      if (target && familyRoots.some((family) => target.startsWith(family)))
        problems.push(
          `client imports backend feature: ${path.relative(root, file)} -> ${path.relative(root, target)}`,
        );
    }
}

function checkPureDependencies(ts, server, problems) {
  for (const relative of pureRules) {
    const file = path.join(server, relative);
    if (!existsSync(file)) continue;
    for (const item of imports(ts, file)) {
      if (item.typeOnly) continue;
      const target = resolveRelative(file, item.specifier);
      if (!target) {
        if (
          /^(?:node:)?(?:fs|net|http|https|child_process|sqlite)(?:\/|$)/.test(
            item.specifier,
          )
        )
          problems.push(
            `pure rule imports I/O: ${relative} -> ${item.specifier}`,
          );
        continue;
      }
      const rel = path.relative(server, target);
      if (
        /^(?:routes|server|workspace-entry|storage|codex|browser-service|.*(?:-api|-http|-adapter))/.test(
          rel,
        )
      )
        problems.push(
          `pure rule imports runtime adapter: ${relative} -> ${rel}`,
        );
    }
  }
}

export function checkBackendLayout(root, { typescriptRoot } = {}) {
  root = path.resolve(root);
  const server = path.join(root, "platform/app/server");
  const client = path.join(root, "platform/app/client");
  const problems = [];
  const ts = loadTypescript(root, typescriptRoot);
  checkContracts(root, problems);
  checkEntry(ts, server, problems);
  checkFeatureFolders(server, problems);
  checkClientDependencies(ts, root, server, client, problems);
  checkPureDependencies(ts, server, problems);
  return problems;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
  const problems = checkBackendLayout(root);
  if (problems.length) {
    for (const problem of problems) console.error(`backend layout: ${problem}`);
    process.exitCode = 1;
  } else console.log("backend layout: ok");
}
