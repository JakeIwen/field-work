#!/usr/bin/env bash
# Copy each provider's autofill helper to <out>/automation/<provider>/ so a
# release keeps the layout autofillHelperFile resolves. Packaging locally
# avoids `rsync -R` and its `/./` marker, which macOS's bundled openrsync
# ignores, uploading the Mac's full source path instead.
# Usage: platform/deploy/package-helpers.sh <out-dir>
set -euo pipefail

[[ $# -eq 1 && -d $1 ]] || { echo "Usage: $0 <existing-out-dir>" >&2; exit 2; }
out=$1
repository_root=$(cd "$(dirname "$0")/../.." && pwd)
for provider in greenhouse; do
  helper=$repository_root/automation/$provider/console-helper.js
  [[ -f "$helper" ]] || { echo "Missing autofill helper: $provider" >&2; exit 1; }
  mkdir -p "$out/automation/$provider"
  cp -p "$helper" "$out/automation/$provider/console-helper.js"
done

# Keep the standalone search userscript available to packaged verification.
cp -p "$repository_root/automation/greenhouse/fieldwork-search.user.js" "$out/automation/greenhouse/fieldwork-search.user.js"
