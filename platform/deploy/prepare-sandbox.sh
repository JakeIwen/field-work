#!/usr/bin/env bash
# Prepare Ubuntu's packaged bubblewrap and AppArmor profile for Codex tools, and
# socat, which Claude Code's Linux Bash sandbox also requires.
# Run as the SSH admin user; only package/profile operations use sudo.
set -euo pipefail

[[ -r /etc/os-release ]] || {
  echo "Cannot identify the Linux distribution" >&2
  exit 1
}
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || {
  echo "Fieldwork sandbox setup supports Ubuntu 24.04 only" >&2
  exit 1
}

missing=""
for package in bubblewrap socat apparmor-profiles apparmor-utils; do
  if ! dpkg-query -W -f='${db:Status-Status}\n' "$package" 2>/dev/null |
    grep -qx 'installed'; then
    missing="$missing $package"
  fi
done
if [[ -n "$missing" ]]; then
  sudo apt-get update -qq
  # Package names are fixed above; no caller-controlled arguments reach apt.
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing
fi

[[ -x /usr/bin/bwrap ]] || {
  echo "Ubuntu bubblewrap was not installed at /usr/bin/bwrap" >&2
  exit 1
}
[[ -x /usr/bin/socat ]] || {
  echo "Ubuntu socat was not installed at /usr/bin/socat" >&2
  exit 1
}
source_profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
target_profile=/etc/apparmor.d/bwrap-userns-restrict
[[ -f "$source_profile" && ! -L "$source_profile" ]] || {
  echo "Ubuntu bwrap AppArmor profile is missing or unsafe" >&2
  exit 1
}
if [[ -e "$target_profile" && ( ! -f "$target_profile" || -L "$target_profile" ) ]]; then
  echo "Existing bwrap AppArmor target is not a regular file" >&2
  exit 1
fi
if ! sudo cmp -s "$source_profile" "$target_profile"; then
  sudo install -o root -g root -m 0644 "$source_profile" "$target_profile"
fi
sudo apparmor_parser -r "$target_profile"

echo "Ubuntu bubblewrap, socat and the restricted-userns AppArmor profile are ready."
