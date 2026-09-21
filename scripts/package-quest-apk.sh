#!/usr/bin/env bash
set -e

echo "========================================================"
echo "   TrekViewer 3D — Meta Quest Standalone APK Packager   "
echo "========================================================"

# 1. Build the production static web app
echo "==> Building production WebXR bundle..."
npm run build

APP_NAME="TrekViewer 3D"
PACKAGE_NAME="com.trekviewer.app"
VERSION_CODE=1
VERSION_NAME="1.0.0"
OUTPUT_APK="./trekviewer.apk"
MANIFEST_PATH="./dist/manifest.webmanifest"

# Check if ovr-platform-util is available
if command -v ovr-platform-util &> /dev/null; then
  echo "==> Detected Meta ovr-platform-util CLI."
  echo "==> Generating signed Meta Quest APK..."
  ovr-platform-util create-pwa-package \
    --manifest-file "$MANIFEST_PATH" \
    --app-name "$APP_NAME" \
    --package-name "$PACKAGE_NAME" \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    --output "$OUTPUT_APK"
  echo "✓ Successfully created $OUTPUT_APK!"
  echo ""
  echo "To install on your Meta Quest 3 via ADB:"
  echo "  adb install -r $OUTPUT_APK"
  echo "Or drag and drop $OUTPUT_APK into SideQuest or Meta Quest Developer Hub."
else
  echo ""
  echo "ℹ️ Note: 'ovr-platform-util' (Meta's official Quest PWA packager) is not currently installed in PATH."
  echo ""
  echo "Option 1 — Install Meta's official CLI tool (one-time setup):"
  echo "  macOS:"
  echo "    curl -L https://securecdn.oculus.com/binaries/efp/ovr-platform-util/latest/ovr-platform-util-mac -o ovr-platform-util"
  echo "    chmod +x ovr-platform-util"
  echo "    sudo mv ovr-platform-util /usr/local/bin/"
  echo ""
  echo "  Then re-run: npm run package:apk"
  echo ""
  echo "Option 2 — Direct WebXR PWA (Recommended, No APK required!):"
  echo "  1. Deploy to free static hosting (e.g. 'npm run deploy:surge' or GitHub Pages)."
  echo "  2. Open the URL in your Meta Quest 3 Browser."
  echo "  3. Tap the '...' menu in the URL bar and select 'Install App'."
  echo "  4. TrekViewer is now installed in your Quest App Library with full-screen WebXR!"
  echo "========================================================"
fi
