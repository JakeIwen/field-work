#!/usr/bin/env bash
# The production route (npm --prefix platform run deploy): a queued release
# runner that verifies and ships a commit, never the working tree. Concurrent sessions
# share one checkout, so its state is normally dirty and irrelevant here: the
# release is a detached worktree of a resolved SHA (default origin/main), the
# bytes that pass the check are the bytes deployed, and callers queue behind a
# lock instead of failing. It verifies the offline suite and what deploy.sh
# itself reports; it never loads the hosted client in a browser, and the closing
# statement says so.
#
# Two instances cooperate: the front (arguments, fetch, plan, detach) starts
# `scripts/run-locked.mjs deploy -- bash live.sh --locked ...`, the same
# machine-wide queueing lock the check and native tiers use, and the --locked
# runner (worktree, check, deploy, records) executes only while holding it,
# either behind `tee` (foreground) or detached into the log (--background), so
# both modes run identical code. Locks and records live under the main
# checkout, so every linked worktree shares one queue and one last.json.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
platform=$root/platform
url=${FIELDWORK_PUBLIC_URL:?Set FIELDWORK_PUBLIC_URL to the production HTTPS origin}
: "${FIELDWORK_SSH_TARGET:?Set FIELDWORK_SSH_TARGET to the deployment SSH destination}"
[[ $FIELDWORK_PUBLIC_URL =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || {
  echo "FIELDWORK_PUBLIC_URL must be an HTTPS origin without a path or credentials" >&2
  exit 2
}

# Runner state lives under the main checkout, never the invoking worktree, so
# every worktree sees one last.json and one lock. last.json and history.log are
# written only while holding the lock, so they never interleave.
main_root=$root
if common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
  [[ $(basename "$common") == .git ]]; then
  main_root=$(dirname "$common")
fi
state_dir=$main_root/.local/deploy
last_file=$state_dir/last.json
history_file=$state_dir/history.log
run_locked=$platform/scripts/run-locked.mjs
lock_name=deploy
ntfy_python=/usr/bin/python3
ntfy_script=${FIELDWORK_DEPLOY_NTFY_SCRIPT:-}
default_ref=origin/main

ref=$default_ref
dry_run=0
background=0
log=
sha=
stage=start
result=
locked=0
release_parent=
release_dir=
original_args=("$@")

usage() {
  echo 'Usage: npm --prefix platform run deploy [-- [--ref <commit-ish>] [--background] [--dry-run]]' >&2
  exit 2
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --ref)
        [[ $# -ge 2 && -n $2 ]] || usage
        ref=$2
        shift 2
        ;;
      --ref=?*)
        ref=${1#--ref=}
        shift
        ;;
      --background) background=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      --locked) locked=1; shift ;;
      *) usage ;;
    esac
  done
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Fetch (so origin/main is current and --ref can name a remote branch), then
# resolve the ref to a full SHA. Prints the SHA; failures name their cause.
fetch_origin() {
  git -C "$root" fetch -q origin || {
    echo 'git fetch origin failed; the release ref cannot be trusted without it.' >&2
    return 1
  }
}

resolve_ref() {
  git -C "$root" rev-parse --verify -q "$ref^{commit}" || {
    echo "Cannot resolve release ref '$ref' to a commit." >&2
    return 1
  }
}

json_field() {  # json_field <file> <key>: first string or number value of a one-key-per-line JSON file
  [[ -f $1 ]] || return 0
  sed -n "s/.*\"$2\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$1" | head -n 1
}

deploying_line() {
  local subject where
  subject=$(git -C "$root" log -1 --format=%s "$1")
  if git -C "$root" merge-base --is-ancestor "$1" origin/main 2>/dev/null; then
    where='on origin/main as of the fetch'
  else
    where='not on origin/main as of the fetch'
  fi
  echo "Deploying $(git -C "$root" rev-parse --short "$1") \"$subject\" (ref $ref, $where)"
}

statement() {
  local short target='' sources='sources from the explicitly selected workspace were published.'
  short=$(git -C "$root" rev-parse --short "$1")
  [[ -z ${FIELDWORK_SSH_TARGET-} ]] || target=" via FIELDWORK_SSH_TARGET=$FIELDWORK_SSH_TARGET"
  [[ -n ${FIELDWORK_WORKSPACE_ROOT-} ]] || sources='workspace sources were not published (FIELDWORK_WORKSPACE_ROOT is unset).'
  [[ ${FIELDWORK_SKIP_SOURCE_SYNC-} != 1 ]] || sources='workspace sources were not published (FIELDWORK_SKIP_SOURCE_SYNC=1).'
  echo "Deployed $short to $url$target."
  echo "Verified: the offline check suite passed on commit $short; deploy.sh reported the cloud backend healthy after the reload; $sources"
  echo 'Not verified: this command did not exercise the hosted client. A client build that renders wrong, a broken route or a bad asset path would not have been caught here.'
  echo "What that means: open $url and check Openings, an Opening detail, Applications and Settings. Earlier release trees stay on the server; rollback is in platform/deploy/README.md under Failure and rollback."
}

lock_state_line() { node "$run_locked" --describe "$lock_name"; }

last_deploy_line() {
  if [[ ! -f $last_file ]]; then
    echo 'none recorded'
    return 0
  fi
  echo "$(json_field "$last_file" result) $(json_field "$last_file" sha | cut -c1-7) at $(json_field "$last_file" finishedAt)"
}

dry_run_plan() {
  local dir='<temp>/fieldwork-release.XXXXXX/checkout'
  echo 'Dry run: nothing below is executed; no lock, worktree, check or deploy.'
  echo "  release ref: $ref -> $1"
  echo "  lock ($(node "$run_locked" --path "$lock_name")): $(lock_state_line)"
  echo "  state: $state_dir (shared by every worktree of this repository)"
  echo "  last deploy: $(last_deploy_line)"
  if [[ $(json_field "$last_file" result) == success && $(json_field "$last_file" sha) == "$1" ]]; then
    echo '  a real run would exit 3: this SHA is already deployed.'
  fi
  echo "  plan: queue on the deploy lock, git worktree add --detach $dir $1 with node_modules linked from $platform/node_modules,"
  echo "        npm --prefix $dir/platform run check, bash $dir/platform/deploy/deploy.sh, remove the worktree."
  echo "  log: $state_dir/<UTC timestamp>-$(printf '%s' "$1" | cut -c1-7).log; one line appended to $history_file"
  deploying_line "$1"
  echo 'A successful run would then print (hypothetical; nothing ran):'
  statement "$1"
}

# ---- front: arguments, fetch, plan, detach -------------------------------

# The locked runner is this script again, started by run-locked.mjs once the
# deploy lock is ours. It carries the original arguments for the owner record.
locked_command() {
  printf '%s\n' node "$run_locked" "$lock_name" -- "$BASH" "$here/live.sh" --locked \
    ${original_args[@]+"${original_args[@]}"}
}

start_background() {
  local -a cmd
  while IFS= read -r line; do cmd+=("$line"); done < <(locked_command)
  # set -m gives the child its own process group, so closing the caller's
  # terminal (SIGHUP to its group) cannot reach it; macOS has no setsid.
  (
    set -m
    FIELDWORK_DEPLOY_NOTIFY=1 FIELDWORK_DEPLOY_LOG=$log \
      nohup "${cmd[@]}" </dev/null >>"$log" 2>&1 &
  )
  echo "Deploying in the background. Log: $log"
}

start_foreground() {
  local code
  local -a cmd
  while IFS= read -r line; do cmd+=("$line"); done < <(locked_command)
  echo "Log: $log" >&2
  set +e
  FIELDWORK_DEPLOY_LOG=$log "${cmd[@]}" 2>&1 | tee -a "$log"
  code=${PIPESTATUS[0]}
  set -e
  return "$code"
}

front() {
  fetch_origin || { echo 'Deploy FAILED at stage fetch.' >&2; return 1; }
  sha=$(resolve_ref) || { echo 'Deploy FAILED at stage fetch.' >&2; return 1; }
  if [[ $dry_run -eq 1 ]]; then
    dry_run_plan "$sha"
    return 0
  fi
  mkdir -p "$state_dir"
  log=$state_dir/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}.log
  : >>"$log"
  if [[ $background -eq 1 ]]; then
    start_background
  else
    start_foreground
  fi
}

# ---- runner: worktree, check, deploy, records (under the deploy lock) -----

remove_release_worktree() {
  [[ -n $release_parent ]] || return 0
  {
    # A failed removal must not leave the registration behind: delete the
    # directory first, then prune, which drops entries whose directory is gone.
    git -C "$root" worktree remove --force "$release_dir" ||
      echo 'Could not remove the release worktree cleanly; deleting it and pruning.'
    rm -rf -- "$release_parent" || echo "Could not delete $release_parent; remove it by hand."
    git -C "$root" worktree prune || echo "git worktree prune failed; run it in $root by hand."
  } >&2
  release_parent=
}

add_release_worktree() {
  release_parent=$(mktemp -d "${TMPDIR:-/tmp}/fieldwork-release.XXXXXX")
  release_dir=$release_parent/checkout
  git -C "$root" worktree add --detach "$release_dir" "$1" >&2
  # The check needs the installed dependencies; deploy.sh excludes node_modules.
  ln -s "$platform/node_modules" "$release_dir/platform/node_modules"
}

# Only ever called under the deploy lock, so appends and last.json never race.
record_run() {
  local short=${sha:0:7} finished
  finished=$(now_utc)
  mkdir -p "$state_dir"
  printf '%s %s %s stage=%s log=%s\n' "$finished" "${result:-failed}" "${short:-unknown}" "$stage" "${log:-none}" >>"$history_file"
  [[ $result != already && -n $sha ]] || return 0
  printf '{\n  "sha": "%s",\n  "finishedAt": "%s",\n  "result": "%s"\n}\n' \
    "$sha" "$finished" "$([[ $result == deployed ]] && echo success || echo failed)" >"$last_file.tmp"
  mv "$last_file.tmp" "$last_file"
}

notify_background() {
  [[ ${FIELDWORK_DEPLOY_NOTIFY-} == 1 && -n $ntfy_script ]] || return 0
  local short=${sha:0:7} message
  short=${short:-unknown}
  case $result in
    deployed) message="$short deployed" ;;
    already) message="$short already deployed" ;;
    *) message="$short FAILED at $stage, see ${log:-the deploy log}" ;;
  esac
  "$ntfy_python" "$ntfy_script" --send 'fieldwork deploy' "$message" default ||
    echo 'Could not send the phone alert.'
}

on_exit() {
  local code=$?
  set +e
  [[ -n $result ]] || result=failed
  [[ $result != failed ]] || echo "Deploy FAILED at stage $stage (exit $code); nothing beyond what is reported above was verified." >&2
  remove_release_worktree
  record_run
  notify_background
  case $result in
    deployed) exit 0 ;;
    already) exit 3 ;;
    *) exit 1 ;;
  esac
}

run_release() {
  stage=worktree
  add_release_worktree "$1" || return 1
  stage=check
  npm --prefix "$release_dir/platform" run check || return 1
  stage=deploy
  bash "$release_dir/platform/deploy/deploy.sh" || return 1
  result=deployed
  statement "$1"
}

runner() {
  trap on_exit EXIT
  trap 'exit 130' INT TERM
  # The lock is ours, possibly after a long wait: whatever origin/main was when
  # this run was queued, deploy what it is now.
  stage=fetch
  fetch_origin
  sha=$(resolve_ref)
  if [[ $(json_field "$last_file" result) == success && $(json_field "$last_file" sha) == "$sha" ]]; then
    echo "already deployed: ${sha:0:7} is the last successful deploy; nothing to do."
    result=already
    exit 3
  fi
  deploying_line "$sha"
  run_release "$sha"
}

parse_args "$@"
if [[ $locked -eq 1 ]]; then
  log=${FIELDWORK_DEPLOY_LOG-}
  runner
else
  front
fi
