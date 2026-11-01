# opencode-env-manager

Manage the environment used by shell commands in an OpenCode session.

The plugin keeps profiles per working directory, lets you switch profiles per
session, and supports session-only overrides. Applying a profile updates the
session environment immediately, so the next shell command the agent runs (or
the next `!` shell command) sees the new values.

## Install

Straight from GitHub:

```jsonc
{
  "plugins": ["github:craig-dougan-maersk/opencode-env-manager"]
}
```

Or vendor a checkout and reference its path:

```bash
git clone git@github.com:craig-dougan-maersk/opencode-env-manager.git ~/plugins/env-manager
```

```jsonc
{
  "plugins": ["/home/you/plugins/env-manager"]
}
```

Git and npm installs resolve the package `exports` map, which points the TUI
part at the prebuilt `tui.js`. Local checkouts load `src/index.ts` directly, so
server changes hot-reload. After editing `src/tui.tsx`, rebuild the bundle:

```bash
npm install        # dev dependencies
npm run build      # regenerates tui.js (bun run build.ts)
npm run typecheck
```

## Usage

- Command palette: **Environment profiles**
- Slash command: `/env` (alias `/envs`)

The menu can:

- view the combined environment (parent shell, `.env` files, profile, session overrides)
- switch the profile for the current session
- edit profile variables and `.env` files
- bind variables to entries in an encrypted vault (see below)
- check vault status and test decryption
- create, copy, rename and delete profiles
- set the default profile for new sessions
- set/unset session-only overrides
- reapply the current profile

Secret-looking values are masked in the combined view. Press `Ctrl+R` in the
view to reveal them, or select a row to see its full value and override chain.

## Profile config

Automatically created at:

```
<workdir>/.opencode/env-profiles.json
```

```json
{
  "version": 1,
  "defaultProfile": "default",
  "vault": {
    "stores": [
      { "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
    ]
  },
  "profiles": {
    "default": {
      "description": "Default profile",
      "envFiles": [".env"],
      "variables": {},
      "secrets": {}
    },
    "dev": {
      "description": "Local development",
      "envFiles": [".env.local", ".env.dev"],
      "variables": {
        "NODE_ENV": "development",
        "API_URL": "http://localhost:3000"
      },
      "secrets": {
        "OPENAI_API_KEY": "openai/api-key"
      }
    }
  }
}
```

- The `default` profile always exists and cannot be deleted.
- New profiles load `.env` by default; missing `.env` is ignored.
- Values are stored as plain text, and the file is written with mode `0600`.
  Vault-backed secrets are the exception: `secrets` holds only the mapping from
  variable name to vault entry, never a value.
- Precedence: parent shell → `.env` files in order → profile variables → session overrides.
- `.env` values support `$VAR` / `${VAR}` / `${VAR:-fallback}` expansion. Profile and
  session values expand only braced `${VAR}` references, so literal `$` characters
  in passwords and tokens are preserved.

## Vault-backed secrets

A profile can bind environment variable names to entries in an encrypted store:

```json
"secrets": {
  "OPENAI_API_KEY": "openai/api-key",
  "GH_TOKEN": "github/token"
}
```

The store is decrypted by an external command, so the plugin holds no crypto of
its own. The default provider is age:

```json
"vault": {
  "stores": [
    { "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
  ],
  "ttlSeconds": 60
}
```

`scripts/init-vault.sh` creates an identity and an empty encrypted store.
`scripts/vault-edit.sh` decrypts to a private temp file, opens `$EDITOR`, and
re-encrypts. The decrypted file is a literal `NAME=value` list: `$VAR` is never
expanded, so credentials containing `$` or backslashes are safe.

### Layered stores

`stores` is an ordered list. The first layer containing an entry wins, so a
project store overrides individual entries and falls through to the inherited
one for everything else.

```json
"vault": {
  "stores": [
    { "store": ".opencode/secrets.age", "keyFile": "~/.config/age/projects/acme.txt" },
    { "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
  ]
}
```

A layer every project inherits is declared once, in
`~/.config/opencode/env-manager.json` (or `$XDG_CONFIG_HOME/opencode/`):

```json
{
  "vault": {
    "stores": [
      { "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
    ],
    "ttlSeconds": 60
  }
}
```

Inherited layers are appended after the project's own and duplicates are
ignored, so each project only declares its own store. Bindings still decide what
a profile is allowed to expose.

A project store that does not exist yet is skipped rather than fatal, so a fresh
clone still resolves inherited entries. Other failures — wrong key, corrupt
store — stop the command instead of falling back silently. `Vault status…` lists
each layer separately and marks missing ones.

A single flat block (`"store"`, `"keyFile"`, `"provider"` without `stores`) is
still read and is rewritten as a one-element `stores` list on the next save.

### What a command sees

1. The agent (or you) runs a shell command that mentions `$OPENAI_API_KEY`.
2. `tool.execute.before` notices the reference, asks you to approve
   `secret.use` for that variable, then decrypts the store.
3. `shell.create.before` sets the variable on that one command's environment.

Consequences that matter:

- The value never enters the session environment, so `env`, `printenv` and
  every other command stay clean.
- The variable is set for the whole command line and anything it spawns, so
  reference it only in a command you are willing to approve.
- The transcript and shell history only ever contain `$OPENAI_API_KEY`.
- Only referenced names are decrypted and injected. A command that mentions no
  bound variable triggers neither a prompt nor a decrypt.
- A missing vault entry fails the command instead of silently injecting an
  empty string.

### Required permission rule

OpenCode's base policy allows unknown actions, so approvals only happen if you
add a rule. Once, in `~/.config/opencode/opencode.json`:

```jsonc
{
  "permissions": [
    { "action": "secret.use", "resource": "*", "effect": "ask" }
  ]
}
```

Approvals are never saved (`save: []`), so every use is a fresh decision.

### Denying direct vault access

Approval is pointless if the agent can read the vault itself. Add deny rules
after the ask rule:

```jsonc
{ "action": "read",  "resource": "*keys.txt",        "effect": "deny" },
{ "action": "read",  "resource": "*secrets.age",     "effect": "deny" },
{ "action": "shell", "resource": "age -d *",         "effect": "deny" },
{ "action": "shell", "resource": "age --decrypt *",  "effect": "deny" },
{ "action": "shell", "resource": "cat *keys.txt*",   "effect": "deny" }
```

These are a speed bump, not a sandbox: shell resources are raw command text, so
a determined command can find another spelling. The real boundary is the
approval prompt and keeping the identity file readable only by you.

### Other backends

`vault.provider` is an argv template with `{store}`, `{keyFile}` and `{cwd}`
substituted. The command must print the whole vault as `NAME=value` lines,
because one entry can be bound to several variables.

```jsonc
// gpg-encrypted dotenv file
"vault": {
  "stores": [{ "provider": ["gpg", "--quiet", "--decrypt", "{store}"], "store": "~/.secrets/vault.gpg" }]
}

// sops values file
"vault": {
  "stores": [{ "provider": ["sops", "--decrypt", "--output-type", "dotenv", "{store}"], "store": "~/vault.sops.env" }]
}
```

Per-entry CLIs such as `pass` or `keepassxc-cli` need a small dump wrapper
instead, for example `~/.local/bin/pass-dump`:

```bash
#!/usr/bin/env bash
set -euo pipefail
find "$HOME/.password-store" -name '*.gpg' | sed 's|.*/\.password-store/||; s|\.gpg$||' |
  while read -r entry; do
    printf '%s=%s\n' "$entry" "$(pass show "$entry" | head -n1)"
  done
```

```jsonc
"vault": { "stores": [{ "provider": ["pass-dump"], "store": "pass" }] }
```

`store` doubles as the label shown in the status dialog when the provider does
not consume it.

### Limits

- Shell commands only, same as the rest of this plugin: MCP servers, the model
  process and other tools never see these variables.
- Values exist in the server process memory while in use and cannot be wiped by
  JavaScript. `ttlSeconds` bounds how long a decrypted copy is cached, and `0`
  disables caching.
- Anything the agent can read, the model can repeat. Approval protects against
  the model using a credential silently; it cannot stop you from approving a
  command that prints it.


## How it works

OpenCode exposes a per-session environment for local shell commands. That
environment replaces the process environment for newly spawned commands, so the
plugin always sends a complete merged map, preserving `PATH`, `HOME`, and other
inherited variables.

Session profile selections are retained across service restarts. Session-only
overrides are intentionally transient and disappear when the plugin/service
restarts.

## Limitations

- Only local shell commands are affected. MCP servers, the model process, and
  other tools are not.
- Already-running shell commands keep their old environment.
- When OpenCode uses a shared background service launched from a different
  shell, the “parent shell” baseline is the TUI process environment; the server
  environment is used as a fallback.
