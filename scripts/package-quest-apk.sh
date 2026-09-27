#!/usr/bin/env bash
set -euo pipefail

# Packages a hosted PWA; it does not bundle an offline copy of dist/.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUEST_ANDROID_DIR="${QUEST_ANDROID_DIR:-$REPO_DIR/quest-package}"
MODE="${1:---build}"
fail() { echo "Error: $*" >&2; exit 1; }
case "$MODE" in --init|--build) ;; *) fail "Usage: npm run package:apk -- [--init|--build]" ;; esac
command -v bubblewrap >/dev/null 2>&1 || fail 'Install @meta-quest/bubblewrap-cli, then retry. No APK was created.'

if [[ "$MODE" == '--init' ]]; then
  [[ "${QUEST_MANIFEST_URL:-}" == https://* ]] || fail 'Set QUEST_MANIFEST_URL to your deployed HTTPS manifest URL.'
  [[ ! -e "$QUEST_ANDROID_DIR/twa-manifest.json" ]] || fail 'Project already initialized; use --build or choose another QUEST_ANDROID_DIR.'
  mkdir -p "$QUEST_ANDROID_DIR"
  cd "$QUEST_ANDROID_DIR"
  bubblewrap init --manifest="$QUEST_MANIFEST_URL" --metaquest
  [[ -s twa-manifest.json ]] || fail 'Bubblewrap did not create twa-manifest.json.'
  echo "Initialized $QUEST_ANDROID_DIR. Configure signing and publish Digital Asset Links before building/testing."
  exit 0
fi

[[ -s "$QUEST_ANDROID_DIR/twa-manifest.json" ]] || fail 'Initialize first: QUEST_MANIFEST_URL=https://your-host/manifest.webmanifest npm run package:apk -- --init'
cd "$QUEST_ANDROID_DIR"
# Compare nanosecond file metadata: macOS Bash's -nt has only second precision.
command -v node >/dev/null 2>&1 || fail 'Node.js is required by Bubblewrap.'
apk_state() {
  node -e 'const fs=require("node:fs");try {const s=fs.statSync("app-release-signed.apk",{bigint:true});console.log([s.ino,s.size,s.mtimeNs,s.ctimeNs].join(":"));}catch(e){if(e.code!=="ENOENT")throw e;}'
}
PREVIOUS_APK_STATE="$(apk_state)"
bubblewrap build
[[ -s app-release-signed.apk && "$(apk_state)" != "$PREVIOUS_APK_STATE" ]] || fail 'Build did not produce a new nonempty app-release-signed.apk; no successful package reported.'
echo "APK created: $QUEST_ANDROID_DIR/app-release-signed.apk"
echo "Install with: adb install -r \"$QUEST_ANDROID_DIR/app-release-signed.apk\""
echo 'This package loads the hosted site. Network access and Quest testing are still required.'
