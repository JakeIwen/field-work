import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const globalStyles = [
  "base.css",
  "overview.css",
  "records.css",
  "documents.css",
  "agents.css",
  "workspace.css",
  "responsive-wide.css",
  "responsive-mobile.css",
  "readability.css",
  "pdf.css",
  "conversations.css",
  "markdown.css",
  "opening-workflow.css",
  "validation.css",
];

const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^;{}]+\)/gi;

function lines(file) {
  return readFileSync(file, "utf8").split("\n").length;
}

function clientStylesheets(client) {
  const stylesheets = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".css")) stylesheets.push(absolute);
    }
  };
  visit(client);
  return stylesheets.sort();
}

export function validateClientStructure(root) {
  const client = path.join(root, "app/client");
  const stylesDirectory = path.join(client, "styles");
  const manifest = path.join(client, "styles.css");
  const expectedManifest = `${globalStyles.map((file) => `@import "./styles/${file}";`).join("\n")}\n`;
  const problems = [];

  const rootFiles = new Set([
    "App.tsx", "main.tsx", "styles.css", "styles-theme.css",
    "vite-env.d.ts",
  ]);
  for (const entry of readdirSync(client, { withFileTypes: true })) {
    if (entry.isFile() && !rootFiles.has(entry.name)) {
      problems.push(`app/client/${entry.name} belongs in a feature folder per AGENTS.md, not the client root`);
    }
  }

  if (readFileSync(manifest, "utf8") !== expectedManifest) {
    problems.push("app/client/styles.css must be the ordered import-only cascade manifest");
  }

  const actualStyles = readdirSync(stylesDirectory)
    .filter((file) => file.endsWith(".css"))
    .sort();
  const expectedStyles = [...globalStyles].sort();
  if (JSON.stringify(actualStyles) !== JSON.stringify(expectedStyles)) {
    problems.push(`app/client/styles/ must contain exactly the imported sheets: ${globalStyles.join(", ")}`);
  }

  for (const file of globalStyles) {
    const relative = `app/client/styles/${file}`;
    const absolute = path.join(root, relative);
    const lineCount = lines(absolute);
    if (lineCount > 800) problems.push(`${relative} has ${lineCount} lines; split it before it becomes another global stylesheet`);
  }

  const paletteStylesheet = path.join(client, "styles-theme.css");
  for (const absolute of clientStylesheets(client)) {
    if (absolute === paletteStylesheet) continue;
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const source = readFileSync(absolute, "utf8");
    const literals = source.match(colorLiteral) ?? [];
    if (literals.length) problems.push(`${relative} defines color literals outside app/client/styles-theme.css: ${[...new Set(literals)].join(", ")}`);
    if (/\[data-theme\b/.test(source)) problems.push(`${relative} defines a theme selector outside app/client/styles-theme.css`);
    if (/\[data-palette\b/.test(source)) problems.push(`${relative} defines a palette selector outside app/client/styles-theme.css`);
  }

  const requiredShellFiles = ["AppPage.tsx", "ShortcutHelp.tsx", "Toast.tsx", "navigation.ts"];
  for (const file of requiredShellFiles) {
    const absolute = path.join(client, "shell", file);
    try {
      if (!statSync(absolute).isFile()) problems.push(`app/client/shell/${file} must remain a file`);
    } catch {
      problems.push(`app/client/shell/${file} is missing`);
    }
  }
  const app = readFileSync(path.join(client, "App.tsx"), "utf8");
  for (const owner of ["./shell/AppPage", "./shell/navigation", "./shell/ShortcutHelp", "./shell/Toast"]) {
    if (!app.includes(owner)) problems.push(`app/client/App.tsx must delegate to ${owner}`);
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = path.resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : ".");
  const problems = validateClientStructure(root);
  if (problems.length) {
    for (const problem of problems) console.error(`client structure: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("client structure: ok");
  }
}
