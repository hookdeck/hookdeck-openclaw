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
#   AGENT_TEST_MODEL=anthropic/claude-haiku-4-5   (must be an id THIS openclaw build knows)
#
# A Hookdeck API key is OPTIONAL. Without one the tools correctly report that
# they need an operator. With one, the read tools query the real API and you can
# see what an agent actually does with live Issues:
#
#   HOOKDECK_TEST_API_KEY=...        (the same key the live suite uses)
#
# That run is READ-ONLY by construction, and not by trusting the questions:
#   - `provisioning.enabled` defaults false, so booting provisions nothing;
#   - `transport.mode` defaults none, so no `hookdeck listen` is started;
#   - `tools.allowMutations: false` removes setup/pause/replay entirely and
#     leaves hookdeck_issues able to list and inspect but not acknowledge,
#     resolve or dismiss.
# So the agent cannot change anything in the project even if it decides to try.
#
# Everything runs against a throwaway profile under the scratch dir. Nothing
# touches ~/.openclaw.
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
HOOKDECK_KEY="$(read_env HOOKDECK_TEST_API_KEY)"

if [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ]; then
  echo "No model key found. Add AGENT_TEST_ANTHROPIC_API_KEY or AGENT_TEST_OPENAI_API_KEY to .env.local"
  exit 2
fi
if [ -n "$ANTHROPIC_KEY" ]; then
  export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"
  MODEL="${MODEL:-anthropic/claude-haiku-4-5}"
else
  export OPENAI_API_KEY="$OPENAI_KEY"
  MODEL="${MODEL:-openai/gpt-5.2-mini}"
fi

if [ -n "$HOOKDECK_KEY" ]; then
  # Read-only: mutations off, no provisioning, no listener.
  HOOKDECK_CONFIG=$(printf '"apiKey": "%s",\n          "tools": { "allowMutations": false },' "$HOOKDECK_KEY")
  KEY_NOTE="with a live Hookdeck API key (read-only: mutations disabled)"
else
  HOOKDECK_CONFIG=""
  KEY_NOTE="without a Hookdeck API key"
fi

rm -rf "$ROOT"; mkdir -p "$STATE"
cat > "$CONFIG" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback", "port": 18801 },
  "plugins": {
    "load": { "paths": ["$(pwd)"] },
    "entries": {
      "hookdeck": {
        "enabled": true,
        "config": {
          $HOOKDECK_CONFIG
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

# 8 normally; 5 with a Hookdeck key, because that run sets
# tools.allowMutations: false and setup/pause/replay are then not registered.
# hookdeck_issues stays in both — its list and get actions are pure reads.
if [ -n "$HOOKDECK_KEY" ]; then EXPECTED_TOOLS=5; else EXPECTED_TOOLS=8; fi
DECLARED=$(grep -o "declared [0-9]* tool(s)" "$LOG" | head -1 | grep -o "[0-9]*")
if [ "${DECLARED:-0}" != "$EXPECTED_TOOLS" ]; then
  echo "Expected $EXPECTED_TOOLS tools, host declared '${DECLARED:-none}'."
  echo "A tool missing from contracts.tools in the manifest is LOGGED, not thrown —"
  echo "the plugin looks healthy and registers nothing. Last lines of the log:"
  tail -12 "$LOG"
  exit 1
fi

if ! grep -q "declared .* tool" "$LOG"; then
  echo "Gateway did not declare tools — aborting. Last lines of the log:"
  tail -12 "$LOG"
  exit 1
fi
echo "model: $MODEL"
echo "hookdeck: $KEY_NOTE"
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
  ./node_modules/.bin/openclaw agent --local --session-key smoke -m "$1" --model "$MODEL" 2>/dev/null | tail -20
}

ask "Call hookdeck_status and report exactly what it returns."
ask "Call hookdeck_doctor and quote its response verbatim."
# Proves the newest tool is visible to a real model and explains itself when it
# cannot act, rather than inventing an answer. No API key in this profile, so
# the correct response is that it needs an operator.
ask "Are there any dead webhook events I should know about? Use the hookdeck tools."

if [ -n "$HOOKDECK_KEY" ]; then
  # These only mean something with a key: without one the tools say they need
  # an operator, which is the other half of what this script proves.
  ask "Using the hookdeck tools, tell me about any open Hookdeck Issues. What kind are they, and what would I have to do to clear one?"
  ask "Acknowledge the oldest open Hookdeck issue for me."
fi

echo
echo "──────────────────────────────────────────────────────────────"
echo "What this proves: a real model SEES the hookdeck_* tools, picks the right one"
echo "from the descriptions alone, and gets back something it can act on. Tool state"
echo "is read from the plugin's state files, so this works even though the agent turn"
echo "runs in the CLI process rather than the Gateway."
if [ -n "$HOOKDECK_KEY" ]; then
  echo
  echo "With a key, it also proves the live paths: open Issues came back with their"
  echo "type and aggregation keys, so the agent could name which connection was"
  echo "failing and how. And the last question asked for a MUTATION on purpose —"
  echo "the correct outcome is a refusal naming tools.allowMutations, not an"
  echo "acknowledged issue."
  echo
  echo "NOT proven here: the issue lifecycle actually writing. Nothing in this run"
  echo "can mutate the project, by construction."
else
  echo
  echo "NOT proven here: tools returning live Hookdeck data. Set HOOKDECK_TEST_API_KEY"
  echo "in .env.local to exercise that read-only."
fi
