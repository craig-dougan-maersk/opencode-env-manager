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
npm run compile    # regenerates tui.js (bun run build.ts)
npm run typecheck
```

Do not rename that script to `build`, `prepare`, `prepack`, `install`,
`preinstall` or `postinstall`: npm treats any of those as a build step and runs
them when the package is installed from git, and OpenCode's git-dependency
preparation fails on them. `compile` avoids the hook while leaving the command
available locally.

## Usage

- Command palette: **Environment profiles**
- Slash command: `/env` (alias `/envs`)

The menu can:

- view the combined environment (parent shell, `.env` files, profile, session overrides)
- switch the profile for the current session
- edit profile variables and `.env` files
- bind variables to entries in an encrypted secret store (see below)
- check secret store status and test decryption
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
  "secretStore": {
    "stores": [
      { "type": "local-age", "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
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
  Secret-store-backed values are the exception: `secrets` holds only the mapping
  from variable name to secret store entry, never a value.
- Precedence: parent shell → `.env` files in order → profile variables → session overrides.
- `.env` values support `$VAR` / `${VAR}` / `${VAR:-fallback}` expansion. Profile and
  session values expand only braced `${VAR}` references, so literal `$` characters
  in passwords and tokens are preserved.

## Secret store

A profile can bind environment variable names to entries in an encrypted store:

```json
"secrets": {
  "OPENAI_API_KEY": "openai/api-key",
  "GH_TOKEN": "github/token"
}
```

The store is decrypted by an external command, so the plugin holds no crypto of
its own. Each layer names the provider that reads it. The built-in provider is
`local-age`: an age-encrypted file on disk, decrypted with the age CLI.

```json
"secretStore": {
  "stores": [
    { "type": "local-age", "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
  ],
  "ttlSeconds": 60
}
```

`scripts/init-local-age.sh` creates an identity and an empty encrypted store.
`scripts/local-age-edit.sh` decrypts to a private temp file, opens `$EDITOR`, and
re-encrypts. The decrypted file is a literal `NAME=value` list: `$VAR` is never
expanded, so credentials containing `$` or backslashes are safe.

### Layered stores

`stores` is an ordered list. The first layer containing an entry wins, so a
project store overrides individual entries and falls through to the inherited
one for everything else.

```json
"secretStore": {
  "stores": [
    { "type": "local-age", "store": ".opencode/secrets.age", "keyFile": "~/.config/age/projects/acme.txt" },
    { "type": "local-age", "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
  ]
}
```

A layer every project inherits is declared once, in
`~/.config/opencode/env-manager.json` (or `$XDG_CONFIG_HOME/opencode/`):

```json
{
  "secretStore": {
    "stores": [
      { "type": "local-age", "store": "~/.config/age/secrets.age", "keyFile": "~/.config/age/keys.txt" }
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
store — stop the command instead of falling back silently. `Secret store status…`
lists each layer separately and marks missing ones.

A single flat block (`"store"`, `"keyFile"`, `"provider"` without `stores`) is
still read and is rewritten as a one-element `stores` list on the next save.
The pre-rename `"vault"` key is likewise still read and rewritten as
`"secretStore"` on the next save.

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
- A missing secret store entry fails the command instead of silently injecting an
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

### Denying direct secret store access

Approval is pointless if the agent can read the store itself. Add deny rules
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

### Other providers

A layer with a `provider` argv template is a `custom` provider: the argv is run
with `{store}`, `{keyFile}` and `{cwd}` substituted. The command must print the
whole store as `NAME=value` lines, because one entry can be bound to several
variables. (A layer is `custom` whenever `provider` is present; `type` is then
implied.)

```jsonc
// gpg-encrypted dotenv file
"secretStore": {
  "stores": [{ "provider": ["gpg", "--quiet", "--decrypt", "{store}"], "store": "~/.secrets/vault.gpg" }]
}

// sops values file
"secretStore": {
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
"secretStore": { "stores": [{ "provider": ["pass-dump"], "store": "pass" }] }
```

`store` doubles as the label shown in the status dialog when the provider does
not consume it.

### Plugin API

Other OpenCode plugins can read secret store entries through two RPC methods on
the `env.manager` RPC id:

- `secretStoreStatus()` lists layer status and entry names, never values.
- `secretStoreGet({ entries: string[] })` returns
  `{ values, missing, warnings, searched }` for up to 64 named entries.

The pre-rename names `vaultStatus()` and `vaultGet()` are still served as
aliases, so a consumer built against env-manager 1.1.0 keeps working.

Environment profiles are reachable through the same RPC id:

- `state({ sessionID, baseEnv })` and `resolve({ sessionID, baseEnv })` return
  the session's resolved environment, including per-session overrides.
- `activeProfile({ sessionID })` returns the profile name alone, so a consumer
  can follow the session without receiving the environment.
- `resolveProfile({ profile, baseEnv })` returns any named profile resolved
  against `baseEnv`, without changing the session's selection. This is what lets
  a consumer run a subprocess under a profile of its own. `profiles[].active` in
  that reply still describes the session's profile, not the resolved one.

`state`, `resolve` and `activeProfile` are session-scoped and have been in every
release; `resolveProfile` was added in 1.3.0.

`secretStoreGet` is a plugin-to-plugin API. It is not exposed as a tool, so the
model never sees the result. The calling plugin is responsible for approving
whatever it does with the material. The SSH manager plugin uses this to load
private keys into a managed `ssh-agent` without putting the key in a shell
command.

## Limits

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
