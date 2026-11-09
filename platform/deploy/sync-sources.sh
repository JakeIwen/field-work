#!/usr/bin/env bash
# Publish an explicitly selected workspace's task instructions, evidence dossier, and current
# general resume master sources to the cloud workspace, where drafting tasks
# read them. The cloud also writes these files (general-master promotion can
# replace them), so a cloud copy is replaced only when it is a version from
# this branch's history or the copy the previous sync installed. Anything else
# is a cloud-side edit to reconcile into the repository first.
# Usage: platform/deploy/sync-sources.sh check|push|fetch
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
code_root=$(cd "$here/../.." && pwd -P)
source_root=${FIELDWORK_WORKSPACE_ROOT:-}
workspace=/var/lib/fieldwork/workspace
action=${1:-}

if [[ $# -ne 1 || ! $action =~ ^(check|push|fetch)$ ]]; then
  echo "Usage: $0 check|push|fetch" >&2
  exit 2
fi

if [[ -z "$source_root" ]]; then
  echo "Source sync skipped: FIELDWORK_WORKSPACE_ROOT is unset; deploying code only."
  exit 0
fi
source_root=$(cd "$source_root" && pwd -P)
if [[ "$source_root" == "$code_root" ]]; then
  echo "FIELDWORK_WORKSPACE_ROOT must be a separate applicant workspace, not the contributor checkout." >&2
  exit 1
fi
ssh_target=${FIELDWORK_SSH_TARGET:?Set FIELDWORK_SSH_TARGET to the deployment SSH destination}

current_version() {
  python3 - "$source_root/source_data/README.md" <<'PY'
from pathlib import Path
import re
import sys

readme = Path(sys.argv[1]).read_text()
match = re.search(
    r"current general content master[^\n]*?source_master_template/(v\d+[^/`\s]*)/",
    readme,
    re.IGNORECASE,
)
if match:
    print(match.group(1))
PY
}

build_sources() {
  local version version_directory candidate name
  version=$(current_version)
  [[ -n $version ]] || {
    echo "source_data/README.md does not name a current general content master version." >&2
    exit 1
  }
  [[ $version =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "The current general content master version contains unsupported characters: $version" >&2
    exit 1
  }
  version_directory=$source_root/source_master_template/$version
  [[ -d $version_directory ]] || {
    echo "Current general content master directory does not exist: source_master_template/$version" >&2
    exit 1
  }

  sources=(
    "AGENTS.md"
    "source_data/github_evidence_dossier.md"
  )
  shopt -s nullglob
  for candidate in "$version_directory"/*; do
    [[ -f $candidate && ! -L $candidate ]] || continue
    name=${candidate##*/}
    # Finder's .DS_Store and editor leftovers are not resume sources.
    [[ $name == .* ]] && continue
    [[ $name =~ ^[A-Za-z0-9._-]+$ ]] || {
      echo "Current general content master contains an unsupported filename: $name" >&2
      echo "Use only letters, numbers, periods, underscores, and hyphens." >&2
      exit 1
    }
    sources+=("source_master_template/$version/$name")
  done
  sources+=(
    "source_data/resume.md"
    "source_data/README.md"
  )
}

is_source_path() {
  local expected
  for expected in "${sources[@]}"; do
    [[ $expected == "$1" ]] && return 0
  done
  return 1
}

build_sources
for source in "${sources[@]}"; do
  [[ -f "$source_root/$source" && ! -L "$source_root/$source" ]] || {
    echo "Missing or symlinked workspace source: $source" >&2
    exit 1
  }
done

remote() {
  ssh -o BatchMode=yes "$ssh_target" "$@"
}

if [[ $action == fetch ]]; then
  for path in "${sources[@]}"; do
    status=0
    remote "sudo test -f '$workspace/$path'" < /dev/null || status=$?
    if [[ $status -eq 1 ]]; then
      echo "$path: cloud copy is missing; fetch skipped."
      continue
    elif [[ $status -ne 0 ]]; then
      exit "$status"
    fi
    copy=$source_root/.local/source-sync/$path
    mkdir -p "$(dirname "$copy")"
    if remote "sudo cat '$workspace/$path'" < /dev/null > "$copy.partial"; then
      mv "$copy.partial" "$copy"
    else
      status=$?
      rm -f -- "$copy.partial"
      exit "$status"
    fi
    echo "Compare: git diff --no-index -- $path .local/source-sync/$path"
  done
  exit 0
fi

# One line per source: cloud blob (or missing), last synced blob (or none), path.
cloud_state() {
  remote "bash -s -- ${sources[*]}" <<'REMOTE'
set -euo pipefail
workspace=/var/lib/fieldwork/workspace
ledger=/opt/fieldwork/source-sync.tsv
for path in "$@"; do
  blob=missing
  if sudo test -f "$workspace/$path"; then
    blob=$(sudo cat "$workspace/$path" | git hash-object --stdin)
  fi
  last=none
  if [[ -f "$ledger" ]]; then
    last=$(awk -F '\t' -v p="$path" '$2 == p { b = $1 } END { print b ? b : "none" }' "$ledger")
  fi
  printf '%s %s %s\n' "$blob" "$last" "$path"
done
REMOTE
}
state=$(cloud_state)

updates=""
diverged=""
while read -r cloud last path; do
  [[ $cloud =~ ^([0-9a-f]{40}|missing)$ && $last =~ ^([0-9a-f]{40}|none)$ ]] &&
    is_source_path "$path" || {
    echo "Unexpected cloud source state: $cloud $last $path" >&2
    exit 1
  }
  local_blob=$(git hash-object --no-filters -- "$source_root/$path")
  known=""
  if git -C "$source_root" rev-parse --show-toplevel >/dev/null 2>&1; then
    known=$(git -C "$source_root" log --format= --raw --no-abbrev HEAD -- "$path" |
      awk '{ print $3; print $4 }')
  fi
  if [[ $cloud == "$local_blob" ]]; then
    echo "$path: cloud copy is current."
  elif [[ $cloud == missing || $cloud == "$last" ]] || grep -qx "$cloud" <<< "$known"; then
    echo "$path: cloud copy will be replaced with the selected workspace's version."
    updates+="$cloud $local_blob $path"$'\n'
  else
    echo "$path: cloud copy has changes the selected workspace does not contain." >&2
    diverged+="$path "
  fi
done <<< "$state"

if [[ -n $diverged ]]; then
  cat >&2 <<'MESSAGE'
Nothing was published. Reconcile the cloud edits first:
  bash platform/deploy/sync-sources.sh fetch
downloads the cloud copies to .local/source-sync/; merge what should stay into
the selected workspace before retrying. To deploy code without publishing sources, set
FIELDWORK_SKIP_SOURCE_SYNC=1.
MESSAGE
  exit 1
fi
if [[ $action == check || -z $updates ]]; then
  exit 0
fi

# A document turn checks its captured sources before publishing, so changing
# them under a running turn would fail it.
remote 'if systemctl is-active --quiet fieldwork.service; then
  sudo -u fieldwork /usr/bin/node /opt/fieldwork/platform/deploy/reload.mjs wait-idle
fi' < /dev/null

upload=$(remote 'mktemp -d' < /dev/null)
[[ $upload =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "Unexpected remote upload directory: $upload" >&2
  exit 1
}
arguments=""
index=0
while read -r cloud new path; do
  [[ -n $path ]] || continue
  remote "cat > '$upload/$index'" < "$source_root/$path"
  arguments+=" $cloud $new $path $index"
  index=$((index + 1))
done <<< "$updates"

remote "bash -s -- '$upload'$arguments" <<'REMOTE'
set -euo pipefail
upload=$1
shift
workspace=/var/lib/fieldwork/workspace
ledger=/opt/fieldwork/source-sync.tsv
trap 'rm -rf -- "$upload"' EXIT
# Check every file before replacing any, so a refusal leaves all of them as they were.
items=("$@")
for ((i = 0; i < ${#items[@]}; i += 4)); do
  expected=${items[i]} new=${items[i + 1]} path=${items[i + 2]} index=${items[i + 3]}
  if [[ $expected == missing ]]; then
    if sudo test -e "$workspace/$path" || sudo test -L "$workspace/$path"; then
      echo "$path changed on the cloud during the sync; nothing was published." >&2
      exit 1
    fi
  else
    current=missing
    if sudo test -f "$workspace/$path"; then
      current=$(sudo cat "$workspace/$path" | git hash-object --stdin)
    fi
    [[ "$current" == "$expected" ]] || {
      echo "$path changed on the cloud during the sync; nothing was published." >&2
      exit 1
    }
  fi
  [[ "$(git hash-object --stdin < "$upload/$index")" == "$new" ]] || {
    echo "$path was not uploaded intact; nothing was published." >&2
    exit 1
  }
done
for ((i = 0; i < ${#items[@]}; i += 4)); do
  new=${items[i + 1]} path=${items[i + 2]} index=${items[i + 3]}
  parent=$(dirname "$workspace/$path")
  if ! sudo test -d "$parent"; then
    sudo install -d -o fieldwork -g fieldwork -m 0755 "$parent"
  fi
  # The suffix keeps the app's file watcher from importing the partial copy.
  sudo install -o fieldwork -g fieldwork -m 0644 "$upload/$index" \
    "$workspace/$path.fieldwork-sync"
  sudo mv -f "$workspace/$path.fieldwork-sync" "$workspace/$path"
  {
    if [[ -f "$ledger" ]]; then awk -F '\t' -v p="$path" '$2 != p' "$ledger"; fi
    printf '%s\t%s\n' "$new" "$path"
  } > "$ledger.partial"
  mv "$ledger.partial" "$ledger"
  echo "Published $path to the cloud workspace."
done
REMOTE
