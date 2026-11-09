#!/usr/bin/env bash
# Parallel-development helper: one command to start a worktree, one to land it.
#
# Landing always runs `git merge --ff-only` from the MAIN checkout. A commit
# once landed on `main` from a worktree copy without refreshing the main
# checkout's working tree, so five files showed as modified for a day. Merging
# in the main checkout updates its index and files together, and git itself
# refuses when uncommitted edits there would be overwritten.
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: worktree.sh <verb> [args]
  new <name>                         branch <name> from main + worktree at
                                     <main>/.claude/worktrees/<name>
  land [<name>] [--test <file>...]   rebase on main, tsc, tests, ff-only merge
                                     from the main checkout, remove worktree
  list                               worktrees: branch, ahead/behind main, dirty
  help                               this text
USAGE
}

die() { echo "worktree: $*" >&2; exit 1; }

# The first entry of `git worktree list --porcelain` is the main checkout.
main_checkout() {
  git worktree list --porcelain | sed -n '1s/^worktree //p'
}

# Path of the worktree that has branch $1 checked out (empty if none).
worktree_of_branch() {
  git worktree list --porcelain | awk -v b="refs/heads/$1" '
    /^worktree /{p=substr($0,10)} $0=="branch " b {print p}'
}

# Dirty = any change, tracked or untracked, other than the node_modules link.
is_dirty() {
  [ -n "$(git -C "$1" status --porcelain --untracked-files=all |
    grep -v -E ' platform/node_modules/?$' || true)" ]
}

# Landing fast-forwards the primary checkout, so it must be on main; another
# session's branch there would be merged into instead. Never switched here.
require_main_branch() {
  local cur
  cur=$(git -C "$1" symbolic-ref -q HEAD || true)
  [ "$cur" = "refs/heads/main" ] ||
    die "the main checkout $1 is on ${cur#refs/heads/} (not main); switch it back or land from a session that owns it"
}

cmd_new() {
  local name="${1:-}"
  [ -n "$name" ] || die "new needs a name"
  git check-ref-format --branch "$name" >/dev/null 2>&1 || die "invalid branch name: $name"
  local main path
  main=$(main_checkout)
  path="$main/.claude/worktrees/$name"
  if git -C "$main" show-ref --verify --quiet "refs/heads/$name"; then
    die "branch $name already exists (git show-ref refs/heads/$name)"
  fi
  [ ! -e "$path" ] || die "directory exists: $path"
  git -C "$main" worktree add -q -b "$name" "$path" main
  if [ -d "$main/platform/node_modules" ]; then
    ln -s "$main/platform/node_modules" "$path/platform/node_modules"
  fi
  echo "$path"
  echo "cd $path"
  echo "npm --prefix platform run dev:client"
}

# Sets globals LAND_NAME, LAND_PATH, LAND_TESTS from the arguments.
land_resolve() {
  local main here
  LAND_NAME=""; LAND_TESTS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --test) shift; while [ $# -gt 0 ] && [ "$1" != "--test" ]; do LAND_TESTS+=("$1"); shift; done ;;
      -*) die "unknown option: $1" ;;
      *) LAND_NAME="$1"; shift ;;
    esac
  done
  main=$(main_checkout)
  if [ -z "$LAND_NAME" ]; then
    here=$(git rev-parse --show-toplevel)
    [ "$here" != "$main" ] || die "in the main checkout, land needs a worktree name"
    LAND_NAME=$(git -C "$here" symbolic-ref --short HEAD) || die "detached HEAD in $here"
  fi
  LAND_PATH=$(worktree_of_branch "$LAND_NAME")
  [ -n "$LAND_PATH" ] || die "no worktree has branch $LAND_NAME (git worktree list)"
  [ "$LAND_PATH" != "$main" ] || die "$LAND_NAME is checked out in the main checkout"
}

land_verify() {
  local wt="$1"; shift
  if ! git -C "$wt" rebase main >/dev/null 2>&1; then
    git -C "$wt" rebase --abort >/dev/null 2>&1 || true
    die "git rebase main conflicted in $wt; aborted, resolve by hand and retry"
  fi
  (cd "$wt/platform" && npx tsc --noEmit -p .) || die "tsc --noEmit failed in $wt"
  if [ $# -gt 0 ]; then
    (cd "$wt/platform" && npx tsx --test "$@") || die "npx tsx --test failed"
  fi
}

cmd_land() {
  local main out
  land_resolve "$@"
  main=$(main_checkout)
  if is_dirty "$LAND_PATH"; then
    die "$LAND_PATH has uncommitted changes (git -C $LAND_PATH status); commit or stash first"
  fi
  require_main_branch "$main"
  # Verification runs in the worktree; the shell may be inside it, so move out
  # before it is removed.
  cd "$main"
  land_verify "$LAND_PATH" ${LAND_TESTS[@]+"${LAND_TESTS[@]}"}
  require_main_branch "$main"
  if ! out=$(git -C "$main" merge --ff-only "$LAND_NAME" 2>&1); then
    echo "$out" >&2
    die "git merge --ff-only $LAND_NAME refused in $main; branch and worktree left in place"
  fi
  rm -f "$LAND_PATH/platform/node_modules"
  git -C "$main" worktree remove "$LAND_PATH"
  git -C "$main" branch -d "$LAND_NAME" >/dev/null
  echo "landed $LAND_NAME; main is $(git -C "$main" rev-parse HEAD)"
}

cmd_list() {
  local main path branch counts dirty
  main=$(main_checkout)
  git -C "$main" worktree list --porcelain | awk '
    /^worktree /{p=substr($0,10)} /^branch /{print p "\t" substr($0,19)}
    /^detached/{print p "\t(detached)"}' |
  while IFS=$'\t' read -r path branch; do
    if [ "$branch" = "(detached)" ]; then counts="-"
    else
      counts=$(git -C "$main" rev-list --left-right --count "main...$branch" |
        awk '{print "ahead " $2 ", behind " $1}')
    fi
    dirty=clean
    if is_dirty "$path"; then dirty=dirty; fi
    printf '%s\t%s\t%s\t%s\n' "$path" "$branch" "$counts" "$dirty"
  done
}

case "${1:-help}" in
  new) shift; cmd_new "$@" ;;
  land) shift; cmd_land "$@" ;;
  list) cmd_list ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
