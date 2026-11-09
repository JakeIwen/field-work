#!/usr/bin/env bash
# Offline structural checks for deployment artifacts. Makes no remote changes.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
for script in \
  "$here/configure-access.sh" \
  "$here/server-setup.sh" \
  "$here/prepare-sandbox.sh" \
  "$here/prepare-companion-ssh.sh" \
  "$here/deploy.sh" \
  "$here/live.sh" \
  "$here/package-helpers.sh" \
  "$here/sync-sources.sh" \
  "$here/test.sh"; do
  bash -n "$script"
done
node --check "$here/reload.mjs"
node --check "$here/../../automation/greenhouse/fieldwork-search.user.js"
for provider in greenhouse; do
  node --check "$here/../../automation/$provider/console-helper.js"
done
# Package and copy the helpers with this Mac's real rsync, as deploy.sh does.
helper_check=$(mktemp -d)
trap 'rm -rf -- "$helper_check"' EXIT
mkdir "$helper_check/package" "$helper_check/release"
"$here/package-helpers.sh" "$helper_check/package"
rsync -a "$helper_check/package/automation/" "$helper_check/release/automation/"
[[ "$(cd "$helper_check/release" && find . -type f | sort)" == \
  $'./automation/greenhouse/console-helper.js\n./automation/greenhouse/fieldwork-search.user.js' ]]
cmp "$here/../../automation/greenhouse/fieldwork-search.user.js" "$helper_check/release/automation/greenhouse/fieldwork-search.user.js"
grep -Fq '"$helper_package/automation/" "$ssh_target:$staging/automation/"' "$here/deploy.sh"
grep -Fq 'Missing packaged autofill helper' "$here/deploy.sh"
! grep -q 'rsync -aR' "$here/deploy.sh"

python3 -B -m unittest discover -s "$here" -p 'test_*.py'

unit=$here/fieldwork.service
grep -qx 'User=fieldwork' "$unit"
grep -qx 'Environment=FIELDWORK_CLOUD_ACCESS=1' "$unit"
grep -qx 'Group=fieldwork' "$unit"
grep -qx 'WorkingDirectory=/opt/fieldwork/platform' "$unit"
grep -qx 'Environment=JOB_SEARCH_ROOT=/var/lib/fieldwork/workspace' "$unit"
grep -qx 'Environment=JOB_SEARCH_DATA=/var/lib/fieldwork/workspace/.local/job-search' "$unit"
grep -qx 'Environment=CODEX_HOME=/var/lib/fieldwork/.codex' "$unit"
grep -qx 'Environment=SHELL=/bin/bash' "$unit"
grep -qx 'Restart=always' "$unit"

grep -q -- '--exclude node_modules' "$here/deploy.sh"
grep -q -- '--exclude .local' "$here/deploy.sh"
grep -q -- '--exclude .git' "$here/deploy.sh"
grep -q 'fieldwork-managed-code' "$here/deploy.sh"
grep -q 'cd "$base"' "$here/deploy.sh"
grep -q 'sudo cp -a "$current/." "$staging/"' "$here/deploy.sh"
! grep -q 'cp .*var/lib/fieldwork' "$here/deploy.sh"
! grep -q 'systemctl enable' "$here/server-setup.sh"
! grep -q 'systemctl start\|systemctl restart' "$here/server-setup.sh"
grep -q 'systemctl enable' "$here/deploy.sh"
grep -q '/api/system/activity' "$here/reload.mjs"
grep -q 'whenIdle: true' "$here/reload.mjs"
grep -q 'wait-idle' "$here/deploy.sh"
grep -q '"$here/sync-sources.sh" check' "$here/deploy.sh"
grep -q '"$here/sync-sources.sh" push' "$here/deploy.sh"
grep -q 'reload.mjs wait-idle' "$here/sync-sources.sh"
grep -q 'live.pid !== previousPid' "$here/reload.mjs"
! grep -q 'systemctl restart' "$here/deploy.sh"
grep -q 'bubblewrap socat apparmor-profiles apparmor-utils' "$here/prepare-sandbox.sh"
grep -q '/usr/share/apparmor/extra-profiles/bwrap-userns-restrict' \
  "$here/prepare-sandbox.sh"
grep -q 'apparmor_parser -r' "$here/prepare-sandbox.sh"
! grep -q 'sysctl' "$here/prepare-sandbox.sh"
grep -q "'bash -s' < \"\$here/prepare-companion-ssh.sh\"" "$here/server-setup.sh"
grep -qx 'ClientAliveInterval 10' "$here/prepare-companion-ssh.sh"
grep -q 'sudo sshd -t' "$here/prepare-companion-ssh.sh"
! grep -q 'systemctl restart' "$here/prepare-companion-ssh.sh"

echo "Fieldwork deployment artifacts passed offline checks."
