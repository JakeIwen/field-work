#!/usr/bin/env bash
# Make sshd drop SSH clients that stop answering, so the Mac companion can
# rebind its reverse forward (cloud 127.0.0.1:44318) after changing networks.
# Without a client-alive check, sshd keeps a vanished client's session and its
# listener until TCP keepalive gives up (two hours), and every reconnect fails
# with "Address already in use" under ExitOnForwardFailure.
# Run as the SSH admin user; only the sshd drop-in and reload use sudo.
set -euo pipefail

target=/etc/ssh/sshd_config.d/20-fieldwork-companion.conf
desired='# Installed by Fieldwork platform/deploy/prepare-companion-ssh.sh.
# Drop a client that misses three checks 10 s apart, freeing its forwards.
ClientAliveInterval 10
ClientAliveCountMax 3'

grep -qx 'Include /etc/ssh/sshd_config.d/\*.conf' /etc/ssh/sshd_config || {
  echo "sshd_config does not include sshd_config.d drop-ins" >&2
  exit 1
}
if [[ -e "$target" && ( ! -f "$target" || -L "$target" ) ]]; then
  echo "Existing $target is not a regular file" >&2
  exit 1
fi
if [[ "$(sudo cat "$target" 2>/dev/null || true)" != "$desired" ]]; then
  printf '%s\n' "$desired" | sudo install -o root -g root -m 0644 /dev/stdin "$target"
  sudo sshd -t
  # Reload keeps existing sessions; only new connections use the new values.
  sudo systemctl reload ssh
fi

effective=$(sudo sshd -T | grep -E '^clientalive(interval|countmax) ')
[[ "$effective" == $'clientaliveinterval 10\nclientalivecountmax 3' ]] || {
  echo "sshd does not apply the companion client-alive values:" >&2
  echo "$effective" >&2
  exit 1
}

echo "sshd drops unresponsive clients after about 30 s."
