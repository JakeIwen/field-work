import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "worktree.sh");
const scratch = process.env.WORKTREE_TEST_TMP ?? undefined;

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const run = (cwd, ...args) => spawnSync("bash", [script, ...args], { cwd, encoding: "utf8" });

function commitFile(repo, rel, text, msg) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
  git(repo, "add", rel);
  git(repo, "commit", "-qm", msg);
}

// A temporary repo on `main` with platform/node_modules (a fake tsc included) ignored by git.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(scratch ?? realpathSync(process.env.TMPDIR ?? "/tmp"), "wt-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, ".gitignore", "/.claude/worktrees/\nnode_modules/\n", "ignore");
  commitFile(repo, "platform/a.txt", "one\n", "base");
  const bin = join(repo, "platform/node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tsc"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "tsc"), 0o755);
  return repo;
}

test("new creates branch, worktree and node_modules link; refuses duplicates", (t) => {
  const repo = fixture(t);
  const r = run(repo, "new", "feat");
  assert.equal(r.status, 0, r.stderr);
  const wt = join(repo, ".claude/worktrees/feat");
  assert.deepEqual(r.stdout.trim().split("\n"), [wt, `cd ${wt}`, "npm --prefix platform run dev:client"]);
  assert.equal(git(wt, "symbolic-ref", "--short", "HEAD"), "feat");
  assert.equal(readlinkSync(join(wt, "platform/node_modules")), join(repo, "platform/node_modules"));
  assert.notEqual(run(repo, "new", "feat").status, 0);
  // also works from inside the worktree, rooted at the main checkout
  const inner = run(wt, "new", "second");
  assert.equal(inner.status, 0, inner.stderr);
  assert.ok(existsSync(join(repo, ".claude/worktrees/second")));
});

test("land rebases, fast-forwards main, removes worktree and branch", (t) => {
  const repo = fixture(t);
  run(repo, "new", "feat");
  const wt = join(repo, ".claude/worktrees/feat");
  commitFile(wt, "platform/b.txt", "b\n", "feat work");
  commitFile(repo, "platform/c.txt", "c\n", "main moved");
  const r = run(wt, "land");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`main is ${git(repo, "rev-parse", "HEAD")}`));
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.ok(existsSync(join(repo, "platform/b.txt")));
  assert.ok(existsSync(join(repo, "platform/c.txt")));
  assert.ok(!existsSync(wt));
  assert.equal(git(repo, "branch", "--list", "feat"), "");
});

test("land refuses a dirty worktree and the main checkout without a name", (t) => {
  const repo = fixture(t);
  run(repo, "new", "feat");
  const wt = join(repo, ".claude/worktrees/feat");
  commitFile(wt, "platform/b.txt", "b\n", "feat work");
  writeFileSync(join(wt, "platform/untracked.txt"), "x");
  const r = run(wt, "land");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted changes/);
  assert.ok(existsSync(wt));
  const m = run(repo, "land");
  assert.notEqual(m.status, 0);
  assert.match(m.stderr, /needs a worktree name/);
  assert.ok(lstatSync(join(wt, "platform/node_modules")).isSymbolicLink());
});

test("land leaves branch and worktree when main has a conflicting local edit", (t) => {
  const repo = fixture(t);
  run(repo, "new", "feat");
  const wt = join(repo, ".claude/worktrees/feat");
  commitFile(wt, "platform/a.txt", "changed in feat\n", "feat edits a");
  writeFileSync(join(repo, "platform/a.txt"), "local edit\n");
  const r = run(repo, "land", "feat");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /git merge --ff-only feat refused/);
  assert.ok(existsSync(wt));
  assert.notEqual(git(repo, "branch", "--list", "feat"), "");
  assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "base");
});

test("land refuses when the main checkout is on another branch", (t) => {
  const repo = fixture(t);
  run(repo, "new", "feat");
  const wt = join(repo, ".claude/worktrees/feat");
  commitFile(wt, "platform/b.txt", "b\n", "feat work");
  git(repo, "checkout", "-q", "-b", "other");
  const mainBefore = git(repo, "rev-parse", "main");
  const r = run(wt, "land");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is on other/);
  assert.ok(existsSync(wt));
  assert.notEqual(git(repo, "branch", "--list", "feat"), "");
  assert.equal(git(repo, "rev-parse", "main"), mainBefore);
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "other");
});

test("land runs requested test files and stops on failure", (t) => {
  const repo = fixture(t);
  run(repo, "new", "feat");
  const wt = join(repo, ".claude/worktrees/feat");
  commitFile(wt, "platform/b.txt", "b\n", "feat work");
  const bin = join(repo, "platform/node_modules/.bin");
  writeFileSync(join(bin, "tsx"), '#!/bin/sh\n[ "$1" = "--test" ] && [ "$2" = "ok.test.ts" ]\n');
  chmodSync(join(bin, "tsx"), 0o755);
  const bad = run(wt, "land", "--test", "bad.test.ts");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /tsx --test failed/);
  assert.ok(existsSync(wt));
  const good = run(wt, "land", "--test", "ok.test.ts");
  assert.equal(good.status, 0, good.stderr);
});

test("list shows ahead/behind and dirty; unknown verb exits 2", (t) => {
  const repo = fixture(t);
  run(repo, "new", "feat");
  const wt = join(repo, ".claude/worktrees/feat");
  commitFile(wt, "platform/b.txt", "b\n", "feat work");
  commitFile(repo, "platform/c.txt", "c\n", "main moved");
  writeFileSync(join(wt, "dirty.txt"), "x");
  const r = run(repo, "list");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${wt}\\tfeat\\tahead 1, behind 1\\tdirty`));
  assert.match(r.stdout, /\tmain\tahead 0, behind 0\tclean/);
  assert.equal(run(repo, "bogus").status, 2);
  assert.equal(run(repo).status, 0);
});
