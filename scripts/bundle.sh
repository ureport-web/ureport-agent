#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
DIST="dist"
BUNDLE_DIR="$DIST/ureport-agent"

echo "Bundling ureport-agent v$VERSION..."

# Clean previous build
rm -rf "$DIST"
mkdir -p "$BUNDLE_DIR"

# Copy distributable files
cp agent.js          "$BUNDLE_DIR/"
cp git-providers.js  "$BUNDLE_DIR/"
cp agent-env.js       "$BUNDLE_DIR/"
cp -R lib            "$BUNDLE_DIR/"
cp package.json      "$BUNDLE_DIR/"
cp package-lock.json "$BUNDLE_DIR/"
cp ureport-agent.yml.example "$BUNDLE_DIR/"
cp LICENSE           "$BUNDLE_DIR/"
cp README.md         "$BUNDLE_DIR/"

# The env file that ships is always a fresh, empty one written here. Never copy the ureport-agent.env in this
# folder: it is yours, it holds real credentials, and it must not end up in the bundle.
cat > "$BUNDLE_DIR/ureport-agent.env" <<'ENVFILE'
# Credentials for playbooks: one KEY=VALUE per line, # for comments.
# List the variable NAMES under "Required environment variables" on the playbook in UReport,
# and put the values here. Example:
#   STAGE_USER=qa-bot
#   STAGE_PASSWORD=your-password
ENVFILE
chmod 600 "$BUNDLE_DIR/ureport-agent.env"

# Install production dependencies only
echo "Installing production dependencies..."
cd "$BUNDLE_DIR"
npm ci --omit=dev --silent
cd ../../

# Create tar.gz (macOS / Linux)
tar -czf "$DIST/ureport-agent.tar.gz" -C "$DIST" ureport-agent
echo "  Created $DIST/ureport-agent.tar.gz"

# Create zip (Windows)
(cd "$DIST" && zip -r "ureport-agent.zip" ureport-agent -x "*.DS_Store")
echo "  Created $DIST/ureport-agent.zip"

echo "Done. Copy to ureport-standalone/agent/ to serve downloads."
