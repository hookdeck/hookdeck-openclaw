#!/usr/bin/env bash
# End-to-end agent smoke test.
#
# Boots an isolated OpenClaw Gateway with this plugin linked, then asks a real
# agent questions that should make it reach for the Hookdeck tools. Proves the
# thing unit tests cannot: that a model picks the right tool from the
# descriptions and gets back something it can act on.
#
# Needs a model key. Add ONE of these to .env.local (gitignored):
#
#   AGENT_TEST_ANTHROPIC_API_KEY=sk-ant-...
#   AGENT_TEST_OPENAI_API_KEY=sk-...
#
# Optionally override the model:
#   AGENT_TEST_MODEL=anthropic/claude-sonnet-5
#
# Everything runs against a throwaway profile under the scratch dir. Nothing
# touches ~/.openclaw, and no Hookdeck API key is required.
set -uo pipefail
cd "$(dirname "$0")/.."

ROOT="${TMPDIR:-/tmp}/hookdeck-openclaw-agent-smoke"
CONFIG="$ROOT/openclaw.json"
STATE="$ROOT/state"
LOG="$ROOT/gateway.log"

read_env() { grep -m1 "^$1=" .env.local 2>/dev/null | cut -d= -f2- | tr -d '[:space:]'; }

ANTHROPIC_KEY="$(read_env AGENT_TEST_ANTHROPIC_API_KEY)"
OPENAI_KEY="$(read_env AGENT_TEST_OPENAI_API_KEY)"
MODEL="$(read_env AGENT_TEST_MODEL)"

if [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ]; then
  echo "No model key found. Add AGENT_TEST_ANTHROPIC_API_KEY or AGENT_TEST_OPENAI_API_KEY to .env.local"
  exit 2
fi
if [ -n "$ANTHROPIC_KEY" ]; then
  export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"
  MODEL="${MODEL:-anthropic/claude-sonnet-5}"
else
  export OPENAI_API_KEY="$OPENAI_KEY"
  MODEL="${MODEL:-openai/gpt-5.2-mini}"
fi

rm -rf "$ROOT"; mkdir -p "$STATE"
cat > "$CONFIG" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback", "port": 18801 },
  "agent": { "model": "$MODEL" },
  "plugins": {
    "load": { "paths": ["$(pwd)"] },
    "entries": {
      "hookdeck": {
        "enabled": true,
        "config": {
          "signingSecret": "whsec_agent_smoke",
          "ingress": { "basePath": "/hookdeck" },
          "routes": {
            "stripe": {
              "source": "stripe",
              "dispatch": { "mode": "wake", "sessionKey": "main", "text": "Stripe {eventId}" }
            }
          }
        }
      }
    }
  }
}
JSON

export OPENCLAW_CONFIG_PATH="$CONFIG" OPENCLAW_STATE_DIR="$STATE"
./node_modules/.bin/openclaw gateway --allow-unconfigured > "$LOG" 2>&1 &
GW=$!
trap 'kill $GW 2>/dev/null' EXIT
sleep 14

if ! grep -q "declared .* tool" "$LOG"; then
  echo "Gateway did not declare tools — aborting."
  grep -iE "error|refus|must declare" "$LOG" | tail -5
  exit 1
fi
echo "model: $MODEL"
grep -o "declared [0-9]* tool(s)" "$LOG" | head -1

# Seed one dead-letter so the diagnostic questions have something real to find.
BODY='{not json'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'whsec_agent_smoke' -binary | base64)
curl -s -o /dev/null -X POST http://127.0.0.1:18801/hookdeck/stripe \
  -H 'content-type: application/json' -H "x-hookdeck-signature: $SIG" \
  -H 'x-hookdeck-eventid: evt_smoke_bad' -H 'x-hookdeck-attempt-count: 1' --data "$BODY"

ask() {
  echo
  echo "──────────────────────────────────────────────────────────────"
  echo "Q: $1"
  ./node_modules/.bin/openclaw agent -m "$1" --json 2>&1 | tail -40
}

ask "Are my Hookdeck webhooks healthy right now? Use your tools and summarise."
ask "Did any webhooks fail or get given up on? If so, explain why."
ask "Is anything misconfigured about my webhook setup?"

echo
echo "──────────────────────────────────────────────────────────────"
echo "Tool calls the agent actually made:"
grep -oE "hookdeck_[a-z_]+" "$LOG" | sort | uniq -c | sort -rn || echo "  (none found in the gateway log)"
