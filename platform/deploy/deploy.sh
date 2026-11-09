#!/usr/bin/env bash
# Stage, build, and promote platform code, then publish the repository's
# task instructions, evidence dossier, and current general resume master sources
# (sync-sources.sh). Never touches runtime data.
# Usage: platform/deploy/deploy.sh [--no-restart]
# FIELDWORK_SKIP_SOURCE_SYNC=1 deploys code only.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
platform_root=$(cd "$here/.." && pwd)
repository_root=$(cd "$platform_root/.." && pwd)
ssh_target=${FIELDWORK_SSH_TARGET:?Set FIELDWORK_SSH_TARGET to the deployment SSH destination}
restart=1

if [[ ${1:-} == --no-restart ]]; then
  restart=0
  shift
fi
[[ $# -eq 0 ]] || { echo "Usage: $0 [--no-restart]" >&2; exit 2; }

# Refuse before staging anything when a cloud source has unreconciled edits.
sync_sources=1
if [[ ${FIELDWORK_SKIP_SOURCE_SYNC:-} == 1 ]]; then
  sync_sources=0
  echo "FIELDWORK_SKIP_SOURCE_SYNC=1: repository-authored task and resume sources are not published."
else
  "$here/sync-sources.sh" check
fi

# Keep code and browser helpers in the same staged release, not runtime sources.
helper_package=$(mktemp -d)
"$here/package-helpers.sh" "$helper_package" || {
  rm -rf -- "$helper_package"
  exit 1
}

release_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
staging=/opt/fieldwork/staging/platform-$release_id
lock=/opt/fieldwork/.deploy-lock

cleanup() {
  rm -rf -- "$helper_package"
  if ! ssh -o BatchMode=yes "$ssh_target" "bash -s -- '$release_id'" <<'CLEANUP'
set -euo pipefail
release_id=$1
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
lock=/opt/fieldwork/.deploy-lock
[[ -f "$lock/owner" ]] || exit 0
[[ "$(cat "$lock/owner")" == "$release_id" ]] || exit 0
if [[ -f "$lock/stage-created" ]]; then
  sudo rm -rf -- "/opt/fieldwork/staging/platform-$release_id"
fi
rm -f "$lock/stage-created"
rm "$lock/owner"
rmdir "$lock"
CLEANUP
  then
    echo "Could not confirm cleanup for deployment $release_id; inspect its lock before retrying." >&2
    return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ssh -o BatchMode=yes "$ssh_target" "bash -s -- '$release_id'" <<'REMOTE'
set -euo pipefail
release_id=$1
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
[[ -f /opt/fieldwork/.fieldwork-deployment-root ]] || {
  echo "Run platform/deploy/server-setup.sh first" >&2
  exit 1
}
mkdir /opt/fieldwork/.deploy-lock 2>/dev/null || {
  echo "Another deployment is active (or left /opt/fieldwork/.deploy-lock)" >&2
  exit 1
}
staging=/opt/fieldwork/staging/platform-$release_id
prepared=0
staging_created=0
cleanup_preparation() {
  if [[ "$prepared" == 0 ]]; then
    if [[ "$staging_created" == 1 ]]; then sudo rm -rf -- "$staging"; fi
    rm -f /opt/fieldwork/.deploy-lock/owner /opt/fieldwork/.deploy-lock/stage-created
    rmdir /opt/fieldwork/.deploy-lock
  fi
}
trap cleanup_preparation EXIT
printf '%s\n' "$release_id" > /opt/fieldwork/.deploy-lock/owner
[[ ! -e "$staging" ]] || { echo "Staging path already exists" >&2; exit 1; }
install -d -m 0750 "$staging"
staging_created=1
touch /opt/fieldwork/.deploy-lock/stage-created
current=/opt/fieldwork/platform
if [[ -e "$current" ]]; then
  sudo test -f "$current/.fieldwork-managed-code" || {
    echo "$current is not marked as deploy-managed; refusing to copy it" >&2
    exit 1
  }
  # This is an independent server-local copy, never a hardlink clone. Keeping
  # mtimes lets rsync transfer only code that changed on the Mac.
  sudo cp -a "$current/." "$staging/"
  sudo chown -R "$(id -un)":fieldwork "$staging"
fi
prepared=1
REMOTE

rsync -a --delete --chmod=Dug+rx,Do-rwx,Fug+r,Fo-rwx \
  --exclude node_modules \
  --exclude dist \
  --exclude .local \
  --exclude .git \
  --exclude .agent \
  --exclude '.env*' \
  --exclude '*.log' \
  "$platform_root/" "$ssh_target:$staging/"

rsync -a --chmod=Dug+rx,Do-rwx,Fug+r,Fo-rwx \
  "$helper_package/automation/" "$ssh_target:$staging/automation/"

ssh -o BatchMode=yes "$ssh_target" \
  "bash -s -- '$release_id' '$restart'" <<'REMOTE'
set -euo pipefail
release_id=$1
restart=$2
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
[[ "$restart" == 0 || "$restart" == 1 ]] || exit 2
base=/opt/fieldwork
staging=$base/staging/platform-$release_id
current=$base/platform
previous=$base/releases/platform-$release_id

[[ -f "$base/.fieldwork-deployment-root" && -f "$staging/package-lock.json" ]] || {
  echo "Invalid Fieldwork staging tree" >&2
  exit 1
}
for provider in greenhouse; do
  [[ -f "$staging/automation/$provider/console-helper.js" ]] || {
    echo "Missing packaged autofill helper: $provider" >&2
    exit 1
  }
done
if [[ -e "$current" ]] && ! sudo test -f "$current/.fieldwork-managed-code"; then
  echo "$current is not marked as deploy-managed; refusing to replace it" >&2
  exit 1
fi

cd "$staging"
npm ci --no-fund --no-audit --loglevel=error
npm run build --silent
printf '%s\n' "$release_id" > .fieldwork-managed-code
cd "$base"

# The running app reads its code tree but never writes it.
sudo chown -R root:fieldwork "$staging"
sudo chmod -R u=rwX,g=rX,o= "$staging"

if systemctl is-active --quiet fieldwork.service; then
  sudo -u fieldwork /usr/bin/node "$staging/deploy/reload.mjs" wait-idle
fi
sudo install -o root -g root -m 0644 "$staging/deploy/fieldwork.service" \
  /etc/systemd/system/fieldwork.service

if [[ -e "$current" ]]; then
  sudo mv "$current" "$previous"
fi
sudo mv "$staging" "$current"
sudo systemctl daemon-reload

if [[ "$restart" == 0 ]]; then
  echo "Promoted $release_id; service enablement was unchanged and it was not restarted."
  exit 0
fi

service_state=$(systemctl is-active fieldwork.service 2>/dev/null || true)
enabled_state=$(systemctl is-enabled fieldwork.service 2>/dev/null || true)
if [[ "$service_state" == active ]]; then
  sudo systemctl enable --quiet fieldwork.service
  if ! sudo -u fieldwork /usr/bin/node "$current/deploy/reload.mjs" reload; then
    systemctl status fieldwork.service --no-pager >&2 || true
    exit 1
  fi
elif [[ "$service_state" == inactive && "$enabled_state" == disabled ]]; then
  sudo systemctl enable --now --quiet fieldwork.service
  if ! sudo -u fieldwork /usr/bin/node "$current/deploy/reload.mjs" wait-start; then
    systemctl status fieldwork.service --no-pager >&2 || true
    sudo journalctl -u fieldwork.service -n 60 --no-pager >&2
    exit 1
  fi
else
  echo "Fieldwork is $service_state ($enabled_state); no automatic restart was attempted." >&2
  systemctl status fieldwork.service --no-pager >&2 || true
  exit 1
fi

# Retain recovery code until the replacement service has passed health checks.
old_releases=$(sudo find "$base/releases" -mindepth 1 -maxdepth 1 \
  -type d -name 'platform-*' -printf '%T@ %p\n' | sort -nr | tail -n +3 |
  cut -d' ' -f2-)
if [[ -n "$old_releases" ]]; then
  while IFS= read -r old; do
    sudo test -f "$old/.fieldwork-managed-code" || {
      echo "Refusing to remove unmarked release $old" >&2
      exit 1
    }
    sudo rm -rf -- "$old"
  done <<< "$old_releases"
fi
echo "Deployed $release_id to healthy Fieldwork service."
REMOTE

# Sources follow healthy code, while this deployment still holds the lock.
if [[ $sync_sources == 1 ]] && ! "$here/sync-sources.sh" push; then
  echo "Code $release_id is deployed, but repository-authored task and resume sources were not published." >&2
  exit 1
fi

cleanup
trap - EXIT INT TERM
