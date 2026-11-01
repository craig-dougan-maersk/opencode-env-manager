#!/usr/bin/env bash
# Create an age identity and an empty encrypted vault for opencode-env-manager.
# Idempotent: existing files are kept.
set -euo pipefail

KEY="${AGE_KEY:-$HOME/.config/age/keys.txt}"
STORE="${VAULT_STORE:-$HOME/.config/age/secrets.age}"

command -v age >/dev/null 2>&1 || { echo "age is not installed: sudo apt install age" >&2; exit 1; }
command -v age-keygen >/dev/null 2>&1 || { echo "age-keygen is missing (package age)" >&2; exit 1; }

mkdir -p "$(dirname "$KEY")" "$(dirname "$STORE")"

if [[ -e "$KEY" ]]; then
  echo "keeping existing identity: $KEY"
else
  (umask 077; age-keygen -o "$KEY" >/dev/null 2>&1)
  chmod 600 "$KEY"
  echo "created identity: $KEY"
fi

recipient="$(age-keygen -y "$KEY")"

if [[ -e "$STORE" ]]; then
  echo "keeping existing store: $STORE"
else
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  cat >"$tmp" <<'EOF'
# One NAME=value per line. Values are literal: $VAR is not expanded.
# openai/api-key=sk-...
# github/token=ghp_...
EOF
  age --encrypt --recipient "$recipient" --output "$STORE" "$tmp"
  chmod 600 "$STORE"
  echo "created store: $STORE"
fi

cat <<EOF

Vault ready.

Add this to .opencode/env-profiles.json (merge with what is already there):

  "vault": {
    "stores": [
      { "store": "$STORE", "keyFile": "$KEY" }
    ]
  }

For a shared layer every project inherits, put the same "vault" block in
~/.config/opencode/env-manager.json instead, and keep only the project store
in each project.

Bind names per profile, for example:

  "secrets": { "OPENAI_API_KEY": "openai/api-key" }

Edit the encrypted contents with: $(dirname "$0")/vault-edit.sh

Public recipient: $recipient
EOF
