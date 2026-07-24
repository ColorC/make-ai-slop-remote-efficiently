#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "$#" -lt 2 ]; then
  echo "usage: $0 VERSION_CODE VERSION_NAME [--offer]" >&2
  exit 2
fi
VERSION_CODE="$1"
VERSION_NAME="$2"
OFFER="${3:-}"
python "$ROOT/tools/build/release_candidate.py" build --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"
MANIFEST="$ROOT/../omnicompany/data/android/candidates/lofa-${VERSION_NAME}-vc${VERSION_CODE}.manifest.json"
if [ "$OFFER" = "--offer" ]; then
  python "$ROOT/tools/build/release_candidate.py" offer "$MANIFEST"
else
  echo "candidate staged; live OTA release was not changed"
fi
