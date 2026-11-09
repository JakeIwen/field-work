#!/usr/bin/env bash
# Prepare the Linux account, directories and systemd unit; check operator-owned environment.
# This does not copy runtime sources/data, deploy code, or start Fieldwork.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
ssh_target=${FIELDWORK_SSH_TARGET:?Set FIELDWORK_SSH_TARGET to the deployment SSH destination}
unit_hash=$(shasum -a 256 "$here/fieldwork.service" | cut -d' ' -f1)

ssh -o BatchMode=yes "$ssh_target" "bash -s -- '$unit_hash'" <<'REMOTE'
set -euo pipefail
expected_unit_hash=$1
# The operator owns this private file. Never read its values into shell variables,
# print them, or create/replace it from deployment configuration.
env_file=/etc/fieldwork/fieldwork.env
if [[ ! -f "$env_file" || -L "$env_file" ]] ||
  [[ "$(sudo stat -c '%U:%G:%a' "$env_file")" != root:root:600 ]]; then
  echo "Cloud environment must be a regular file, root:root, mode 0600: /etc/fieldwork/fieldwork.env. See deploy/README.md." >&2
  exit 1
fi
# Parse, never source, the operator's private file. Errors name keys, not values.
sudo python3 - "$env_file" <<'PYTHON'
import re
import shlex
import sys

required = ("FIELDWORK_CLOUD_ACCESS", "FIELDWORK_OWNER_EMAIL", "FIELDWORK_CLOUD_TEAM_URL",
            "FIELDWORK_CLOUD_ACCESS_AUD", "FIELDWORK_PUBLIC_ORIGIN", "FIELDWORK_MACHINE_TOKEN_FILE")
values = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key not in required:
        continue
    try:
        parts = shlex.split(value)
    except ValueError:
        parts = []
    values[key] = parts[0] if len(parts) == 1 else ""
missing = [key for key in required if not values.get(key)]
# EnvironmentFile overrides the unit's Environment=, so local mode is forbidden.
if values.get("FIELDWORK_CLOUD_ACCESS") != "1":
    missing.append("FIELDWORK_CLOUD_ACCESS=1")
if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", values.get("FIELDWORK_OWNER_EMAIL", "")):
    missing.append("valid FIELDWORK_OWNER_EMAIL")
if missing:
    sys.exit("Incomplete cloud environment: " + ", ".join(missing) + ". See deploy/README.md.")
PYTHON

[[ "$expected_unit_hash" =~ ^[a-f0-9]{64}$ ]] || exit 2

unit=/etc/systemd/system/fieldwork.service
if [[ -e "$unit" && ( ! -f "$unit" || -L "$unit" ) ]]; then
  echo "Existing fieldwork.service is not a regular file" >&2
  exit 1
fi
if [[ -f "$unit" && "$(sha256sum "$unit" | cut -d' ' -f1)" != "$expected_unit_hash" ]]; then
  [[ -f /opt/fieldwork/.fieldwork-deployment-root ]] &&
    grep -qx 'User=fieldwork' "$unit" &&
    grep -qx 'WorkingDirectory=/opt/fieldwork/platform' "$unit" &&
    grep -qx 'ExecStart=/usr/bin/node --import tsx app/server/index.ts' "$unit" || {
      echo "Existing fieldwork.service is not a recognized Fieldwork unit" >&2
      exit 1
    }
fi

if getent group fieldwork >/dev/null; then
  [[ "$(getent group fieldwork | cut -d: -f1)" == fieldwork ]] || {
    echo "Unexpected fieldwork group record" >&2
    exit 1
  }
else
  sudo groupadd --system fieldwork
fi

if id fieldwork >/dev/null 2>&1; then
  entry=$(getent passwd fieldwork)
  [[ "$(printf '%s' "$entry" | cut -d: -f6)" == /var/lib/fieldwork ]] || {
    echo "Existing fieldwork user has the wrong home" >&2
    exit 1
  }
  [[ "$(printf '%s' "$entry" | cut -d: -f7)" == /bin/bash ]] || {
    echo "Existing fieldwork user has the wrong shell" >&2
    exit 1
  }
else
  sudo useradd --system --gid fieldwork --create-home \
    --home-dir /var/lib/fieldwork --shell /bin/bash fieldwork
fi
sudo passwd -l fieldwork >/dev/null

ensure_directory() {
  target=$1
  owner=$2
  group=$3
  mode=$4
  if [[ -e "$target" ]]; then
    [[ -d "$target" && ! -L "$target" ]] || {
      echo "$target is not a real directory" >&2
      exit 1
    }
    [[ "$(stat -c '%U:%G' "$target")" == "$owner:$group" ]] || {
      echo "$target has foreign ownership; refusing to change it" >&2
      exit 1
    }
    sudo chmod "$mode" "$target"
  else
    sudo install -d -o "$owner" -g "$group" -m "$mode" "$target"
  fi
}

ensure_directory /var/lib/fieldwork fieldwork fieldwork 0750
ensure_directory /var/lib/fieldwork/workspace fieldwork fieldwork 0700
ensure_directory /var/lib/fieldwork/workspace/.local fieldwork fieldwork 0700
ensure_directory /var/lib/fieldwork/workspace/.local/job-search fieldwork fieldwork 0700
ensure_directory /var/lib/fieldwork/.codex fieldwork fieldwork 0700
ensure_directory /etc/fieldwork root root 0755

if [[ ! -e /opt/fieldwork ]]; then
  sudo install -d -o "$USER" -g fieldwork -m 0750 /opt/fieldwork
elif [[ ! -f /opt/fieldwork/.fieldwork-deployment-root ]]; then
  if [[ -n "$(sudo find /opt/fieldwork -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "/opt/fieldwork is nonempty and is not marked as Fieldwork-owned" >&2
    exit 1
  fi
  sudo chown "$USER":fieldwork /opt/fieldwork
  sudo chmod 0750 /opt/fieldwork
fi
sudo touch /opt/fieldwork/.fieldwork-deployment-root
sudo chown root:fieldwork /opt/fieldwork/.fieldwork-deployment-root
sudo chmod 0640 /opt/fieldwork/.fieldwork-deployment-root
sudo install -d -o "$USER" -g fieldwork -m 0750 \
  /opt/fieldwork/releases /opt/fieldwork/staging


echo "Fieldwork server directories are prepared."
echo "Install the Access audience, machine token, source workspace, and data before starting."
REMOTE

ssh -o BatchMode=yes "$ssh_target" 'bash -s' < "$here/prepare-sandbox.sh"
ssh -o BatchMode=yes "$ssh_target" 'bash -s' < "$here/prepare-companion-ssh.sh"
ssh -o BatchMode=yes "$ssh_target" \
  'sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/fieldwork.service && sudo systemctl daemon-reload' \
  < "$here/fieldwork.service"
echo "Fieldwork systemd unit is installed but not enabled or started."
