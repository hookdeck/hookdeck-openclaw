#!/usr/bin/env bash
# Loads the PACKAGED plugin in a real Gateway, not the working tree.
#
# `npm pack` honours the `files` field, so a file the plugin needs at runtime
# but nobody listed is invisible to every other test in this repo — they all
# read the source directory, where it is present.
#
# Everything runs from OUTSIDE the repo. Run it from inside and the working
# tree shadows the extracted package, and the test passes without ever loading
# what was shipped.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

ROOT="${TMPDIR:-/tmp}/hookdeck-openclaw-package"
rm -rf "$ROOT"; mkdir -p "$ROOT/state"

echo "==> packing"
TARBALL="$(npm pack --silent --pack-destination "$ROOT")" || exit 1
echo "    $TARBALL"

echo "==> extracting outside the repo"
tar -xzf "$ROOT/$TARBALL" -C "$ROOT"
PKG="$ROOT/package"

# The runtime dependencies are not in the tarball; link the ones the repo
# already resolved rather than hitting the network.
mkdir -p "$PKG/node_modules"
for dep in typebox zod openclaw; do
  [ -d "$REPO/node_modules/$dep" ] && ln -sfn "$REPO/node_modules/$dep" "$PKG/node_modules/$dep"
done

echo "==> what shipped"
( cd "$PKG" && find . -name node_modules -prune -o -type f -print | sed 's|^\./||' | sort )

for required in openclaw.plugin.json index.ts LICENSE README.md; do
  if [ ! -f "$PKG/$required" ]; then
    echo "MISSING from the package: $required"
    exit 1
  fi
done

if [ -d "$PKG/test" ]; then
  echo "The test suite shipped to users. Check the files field."
  exit 1
fi

cat > "$ROOT/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback", "port": 18851 },
  "plugins": {
    "load": { "paths": ["$PKG"] },
    "entries": { "hookdeck": { "enabled": true, "config": {
      "signingSecret": "whsec_package_test",
      "ingress": { "basePath": "/hookdeck" },
      "routes": { "stripe": { "source": "stripe",
        "dispatch": { "mode": "wake", "sessionKey": "main" } } }
    } } }
  }
}
JSON

echo "==> booting a Gateway from the extracted package"
cd "$ROOT"   # outside the repo, so nothing shadows the install
OPENCLAW_CONFIG_PATH="$ROOT/openclaw.json" OPENCLAW_STATE_DIR="$ROOT/state" \
  "$REPO/node_modules/.bin/openclaw" gateway --allow-unconfigured > "$ROOT/gw.log" 2>&1 &
GW=$!
trap 'kill $GW 2>/dev/null' EXIT
sleep 14

fail() { echo "FAIL: $1"; echo "--- log ---"; tail -20 "$ROOT/gw.log"; exit 1; }

grep -q "ingress ready" "$ROOT/gw.log" || fail "the packaged plugin did not start"
TOOLS=$(grep -o "declared [0-9]* tool(s)" "$ROOT/gw.log" | head -1 | grep -o "[0-9]*")
[ "${TOOLS:-0}" = "8" ] || fail "expected 8 tools from the package, saw '${TOOLS:-none}'"

BODY='{"type":"invoice.paid"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'whsec_package_test' -binary | base64)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18851/hookdeck/stripe \
  -H 'content-type: application/json' -H "x-hookdeck-signature: $SIG" \
  -H 'x-hookdeck-eventid: evt_pkg' -H 'x-hookdeck-attempt-count: 1' --data "$BODY")
[ "$CODE" = "200" ] || fail "a signed delivery to the packaged plugin answered $CODE"

echo
echo "PASS: the packaged plugin loads, declares 8 tools, and verifies a signed delivery."
echo "      Size: $(du -h "$ROOT/$TARBALL" | cut -f1)"
