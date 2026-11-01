#!/usr/bin/env bash
# Decrypt the vault to a private temp file, open $EDITOR, re-encrypt.
set -euo pipefail

KEY="${AGE_KEY:-$HOME/.config/age/keys.txt}"
STORE="${VAULT_STORE:-$HOME/.config/age/secrets.age}"

command -v age >/dev/null 2>&1 || { echo "age is not installed: sudo apt install age" >&2; exit 1; }
[[ -r "$KEY" ]] || { echo "identity not found: $KEY (run init-vault.sh)" >&2; exit 1; }
[[ -r "$STORE" ]] || { echo "store not found: $STORE (run init-vault.sh)" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

age --decrypt --identity "$KEY" "$STORE" >"$tmp"
"${EDITOR:-vi}" "$tmp"

recipient="$(age-keygen -y "$KEY")"
age --encrypt --recipient "$recipient" --output "$STORE" "$tmp"
chmod 600 "$STORE"
echo "updated $STORE"
