import { Plugin } from "@opencode/plugin/tui"
import { createEffect, on } from "solid-js"
import { EnvManager } from "./rpc.js"

type Entry = { key: string; value: string; source: string; chain: string[] }
type UnsetEntry = { key: string; source: string }

type ProfileInfo = {
  name: string
  description?: string
  variableCount: number
  secretCount: number
  variables: Record<string, string>
  secrets: Record<string, string>
  envFiles: string[]
  active: boolean
  isDefault: boolean
}

type EnvState = {
  directory: string
  configPath: string
  sessionID: string | null
  profile: string
  defaultProfile: string
  profiles: ProfileInfo[]
  envFiles: Array<{ path: string; exists: boolean }>
  availableEnvFiles: string[]
  environment: Record<string, string>
  entries: Entry[]
  unset: UnsetEntry[]
  warnings: string[]
  overrides: { set: Record<string, string>; unset: string[] }
  secrets: Array<{ name: string; entry: string }>
  secretStore: {
    configured: boolean
    stores: string[]
    ttlSeconds: number
  }
}

const SECRET = /(?:^|_)(password|passphrase|secret|token|api[_-]?key|credential|private[_-]?key|auth)(?:_|$)/i
const CUSTOM = "__custom__"

export default Plugin.define({
  id: "env.manager.tui",
  async setup(context) {
    const rpc = context.client.rpc(EnvManager)
    const terminalEnv = snapshotEnvironment()
    const applied = new Set<string>()
    const applying = new Set<string>()

    function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info", title = "Environment") {
      context.ui.toast.show({ title, message, variant, duration: variant === "error" ? 7000 : 3500 })
    }

    function toastError(prefix: string, error: unknown) {
      toast(`${prefix}: ${messageOf(error)}`, "error")
    }

    function currentSessionID(): string | undefined {
      try {
        const route = context.ui.router.current()
        if (route.type === "session") return route.sessionID
      } catch {
        // The router may not be ready during early setup.
      }
      return context.ui.panel.current()?.sessionID
    }

    async function sessionLocation(sessionID?: string): Promise<any> {
      if (!sessionID) return context.location ?? context.data.location.default()
      let info = context.data.session.get(sessionID)
      if (!info) {
        await context.data.session.sync(sessionID).catch(() => undefined)
        info = context.data.session.get(sessionID)
      }
      return info?.location ?? context.location ?? context.data.location.default()
    }

    async function getState(sessionID?: string, location?: any): Promise<EnvState> {
      return (await rpc.state(
        { sessionID, baseEnv: terminalEnv },
        { location: location ?? (await sessionLocation(sessionID)) },
      )) as EnvState
    }

    // Every RPC call must carry the location. Without it the call is handled by
    // the plugin instance for the TUI's own directory, while reads use the
    // session's directory: profile edits and overrides then went to a different
    // env-profiles.json than the one the session listed and applied.
    async function call<T = any>(method: string, input: unknown, sessionID?: string): Promise<T> {
      const location = await sessionLocation(sessionID)
      return (await (rpc as any)[method](input, { location })) as T
    }

    async function applyState(sessionID: string | undefined, state: EnvState, quiet = false): Promise<boolean> {
      if (!sessionID) {
        if (!quiet) toast("Open a session first; the profile was saved for this directory.", "warning")
        return false
      }
      try {
        await (context.client.session as any).environment({ sessionID, variables: state.environment })
        if (!quiet) {
          toast(`Applied "${state.profile}" (${Object.keys(state.environment).length} variables)`, "success")
        }
        return true
      } catch (error) {
        if (!quiet) toastError("Could not apply environment", error)
        return false
      }
    }

    async function ensureApplied(sessionID: string, location?: any) {
      if (applied.has(sessionID)) return
      applied.add(sessionID)
      try {
        const state = await getState(sessionID, location)
        await applyState(sessionID, state, true)
      } catch (error) {
        applied.delete(sessionID)
        console.error("[env-manager] automatic apply failed", error)
      }
    }

    async function reapply(sessionID: string, location?: any) {
      if (applying.has(sessionID)) return
      applying.add(sessionID)
      try {
        const state = await getState(sessionID, location)
        await applyState(sessionID, state, true)
      } catch (error) {
        console.error("[env-manager] refresh apply failed", error)
      } finally {
        applying.delete(sessionID)
      }
    }

    function sourceLabel(source: string): string {
      if (source === "parent") return "Parent shell"
      if (source === "session") return "Session override"
      if (source.startsWith("file:")) return `Env file ${source.slice(5)}`
      if (source.startsWith("profile:")) return `Profile ${source.slice(8)}`
      return source
    }

    function chainLabel(chain: string[]): string {
      return chain.map(sourceLabel).join(" ← ")
    }

    function visibleValue(entry: Entry, reveal: boolean): string {
      if (!reveal && SECRET.test(entry.key)) return "••••••"
      return entry.value.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t")
    }

    function truncate(value: string, limit = 140): string {
      return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
    }

    function profileDescription(profile: ProfileInfo): string {
      const parts = [`${profile.variableCount} variable${profile.variableCount === 1 ? "" : "s"}`]
      if (profile.secretCount) parts.push(`${profile.secretCount} secret${profile.secretCount === 1 ? "" : "s"}`)
      parts.push(profile.envFiles.length ? profile.envFiles.join(", ") : "no .env files")
      if (profile.isDefault) parts.push("default for new sessions")
      if (profile.active) parts.push("active")
      return parts.join(" · ")
    }

    async function showSecretStoreStatus(configPath: string, sessionID?: string) {
      try {
        const status: any = await call("secretStoreStatus", { baseEnv: terminalEnv }, sessionID)
        if (!status?.configured) {
          await context.ui.dialog.alert({
            title: "Secret store not configured",
            message: `Add a "secretStore" block to ${configPath}, or a global layer in ~/.config/opencode/env-manager.json.`,
          })
          return
        }

        const lines: string[] = []
        for (const [index, layer] of (status.layers ?? []).entries()) {
          lines.push(`${index + 1}. ${layer.store ?? layer.provider}`)
          if (layer.ok) lines.push(`   ok · ${layer.entries.length} entries`)
          else if (layer.missing) lines.push("   not created yet; inherited layers still apply")
          else lines.push(`   failed: ${layer.error}`)
          if (layer.ok && layer.entries.length) lines.push(`   ${layer.entries.join(", ")}`)
          for (const warning of layer.warnings ?? []) lines.push(`   ⚠ ${warning}`)
        }

        if (status.warnings?.length) lines.push("", ...status.warnings.map((warning: string) => `⚠ ${warning}`))
        await context.ui.dialog.alert({
          title: `Secret store status — ${status.layers.length} layer${status.layers.length === 1 ? "" : "s"}`,
          message: lines.join("\n"),
        })
      } catch (error) {
        toastError("Secret store status failed", error)
      }
    }

    async function pickProfile(state: EnvState, title: string, current?: string): Promise<string | undefined> {
      return context.ui.dialog.select({
        title,
        current,
        options: state.profiles.map((profile) => ({
          title: profile.name,
          value: profile.name,
          description: profileDescription(profile),
          category: profile.active ? "Active" : undefined,
        })),
      })
    }

    async function viewEnvironment(state: EnvState) {
      let reveal = false
      for (;;) {
        let revealRequested = false
        const options = [
          ...state.secrets.map((secret) => ({
            title: `${secret.name} = •••••• (secret store)`,
            value: `secret:${secret.name}`,
            description: `entry ${secret.entry} · injected per command`,
            category: "Secrets",
          })),
          ...state.entries.map((entry) => ({
            title: `${entry.key} = ${truncate(visibleValue(entry, reveal))}`,
            value: entry.key,
            description: entry.chain.length > 1 ? chainLabel(entry.chain) : undefined,
            category: sourceLabel(entry.source),
          })),
          ...state.unset.map((entry) => ({
            title: `${entry.key} (unset)`,
            value: `unset:${entry.key}`,
            description: sourceLabel(entry.source),
            category: "Unset",
          })),
          ...state.warnings.map((warning, index) => ({
            title: `⚠ ${truncate(warning, 100)}`,
            value: `warning:${index}`,
            category: "Warnings",
          })),
        ]

        const choice = await context.ui.dialog.select({
          title: `Environment — ${state.profile} (${state.entries.length})`,
          placeholder: "Search variables",
          options,
          search: (query, available) => {
            const needle = query.trim().toLowerCase()
            if (!needle) return available
            return available.filter(
              (option) =>
                option.title.toLowerCase().includes(needle) ||
                (option.description ?? "").toLowerCase().includes(needle),
            )
          },
          actions: reveal
            ? []
            : [
                {
                  bind: "ctrl+r",
                  title: "Reveal secrets",
                  selection: "none" as const,
                  onTrigger: () => {
                    reveal = true
                    revealRequested = true
                    context.ui.dialog.clear()
                  },
                },
              ],
        })

        if (revealRequested) continue
        if (!choice) return

        if (choice.startsWith("secret:")) {
          const name = choice.slice(7)
          const binding = state.secrets.find((item) => item.name === name)
          if (!binding) continue
          await context.ui.dialog.alert({
            title: binding.name,
            message: `Stored in the secret store as "${binding.entry}".\n\nThis value is never displayed and never added to the session environment. It is decrypted only for a shell command that references $${binding.name}, after you approve that command.`,
          })
          continue
        }

        if (choice.startsWith("unset:")) {
          const key = choice.slice(6)
          const entry = state.unset.find((item) => item.key === key)
          await context.ui.dialog.alert({
            title: key,
            message: `Unset by session override.\n\nPrevious source: ${entry ? sourceLabel(entry.source) : "unknown"}`,
          })
          continue
        }

        if (choice.startsWith("warning:")) {
          const index = Number(choice.slice(8))
          const warning = state.warnings[index] ?? "Unknown warning"
          await context.ui.dialog.alert({ title: "Environment warning", message: warning })
          continue
        }

        const entry = state.entries.find((item) => item.key === choice)
        if (!entry) continue
        await context.ui.dialog.alert({
          title: entry.key,
          message: `Value:\n${entry.value}\n\nSource: ${sourceLabel(entry.source)}\nOverride chain: ${chainLabel(entry.chain)}`,
        })
      }
    }

    async function afterProfileEdit(sessionID: string | undefined, activeNames: string[], savedName: string) {
      if (!sessionID) {
        toast(`Saved "${savedName}". Open a session to apply it.`, "info")
        return
      }
      const fresh = await getState(sessionID)
      if (activeNames.includes(fresh.profile)) {
        await applyState(sessionID, fresh)
      } else {
        toast(`Saved "${savedName}". Switch to it to apply it to this session.`, "info")
      }
    }

    async function editProfile(sessionID: string | undefined, state: EnvState) {
      const name = await pickProfile(state, "Edit profile", state.profile)
      if (!name) return

      for (;;) {
        const fresh = await getState(sessionID)
        const profile = fresh.profiles.find((item) => item.name === name)
        if (!profile) {
          toast(`Profile "${name}" no longer exists.`, "warning")
          return
        }

        const action = await context.ui.dialog.select({
          title: `Edit "${name}"`,
          options: [
            { title: "Set / override variable…", value: "set" },
            { title: "Remove variable…", value: "remove", disabled: profile.variableCount === 0 },
            {
              title: "Manage secret-store secrets…",
              value: "secrets",
              description: profile.secretCount ? `${profile.secretCount} bound` : "none bound",
            },
            { title: "Add .env file…", value: "add-file" },
            { title: "Remove .env file…", value: "remove-file", disabled: profile.envFiles.length === 0 },
            { title: "Clear .env files", value: "clear-files", disabled: profile.envFiles.length === 0 },
            { title: "Rename profile…", value: "rename" },
            { title: "Back", value: "back" },
          ],
        })
        if (!action || action === "back") return

        try {
          if (action === "set") {
            const key = (await context.ui.dialog.prompt({
              title: "Variable name",
              description: "Letters, digits and underscores; must not start with a digit.",
              placeholder: "API_URL",
            }))?.trim()
            if (!key) continue
            const value = await context.ui.dialog.prompt({
              title: `Value for ${key}`,
              placeholder: "value",
              value: profile.variables[key] ?? "",
            })
            if (value === undefined) continue
            await call("setVariable", { profile: name, key, value, baseEnv: terminalEnv }, sessionID)
            await afterProfileEdit(sessionID, [name], name)
          }

          if (action === "remove") {
            const key = await context.ui.dialog.select({
              title: `Remove variable from "${name}"`,
              options: Object.keys(profile.variables).sort().map((item) => ({
                title: item,
                value: item,
                description: truncate(profile.variables[item]),
              })),
            })
            if (!key) continue
            await call("removeVariable", { profile: name, key, baseEnv: terminalEnv }, sessionID)
            await afterProfileEdit(sessionID, [name], name)
          }

          if (action === "secrets") {
            const sub = await context.ui.dialog.select({
              title: `Secret-store secrets for "${name}"`,
              options: [
                { title: "Bind a variable to a secret-store entry…", value: "add" },
                { title: "Remove a binding…", value: "remove", disabled: profile.secretCount === 0 },
                { title: "Secret store status / test decryption…", value: "test" },
                { title: "Back", value: "back" },
              ],
            })
            if (!sub || sub === "back") continue

            if (sub === "add") {
              const variable = (
                await context.ui.dialog.prompt({
                  title: "Variable name",
                  description: "The name a shell command references as $NAME.",
                  placeholder: "OPENAI_API_KEY",
                })
              )?.trim()
              if (!variable) continue
              const entry = (
                await context.ui.dialog.prompt({
                  title: `Secret-store entry for ${variable}`,
                  description: "Entry name inside the decrypted store, for example openai/api-key.",
                  placeholder: "openai/api-key",
                })
              )?.trim()
              if (!entry) continue
              await call("setSecret", { profile: name, name: variable, entry, baseEnv: terminalEnv }, sessionID)
              await afterProfileEdit(sessionID, [name], name)
            }

            if (sub === "remove") {
              const variable = await context.ui.dialog.select({
                title: `Remove secret-store binding from "${name}"`,
                options: Object.keys(profile.secrets)
                  .sort()
                  .map((item) => ({ title: item, value: item, description: `entry ${profile.secrets[item]}` })),
              })
              if (!variable) continue
              await call("removeSecret", { profile: name, name: variable, baseEnv: terminalEnv }, sessionID)
              await afterProfileEdit(sessionID, [name], name)
            }

            if (sub === "test") {
              await showSecretStoreStatus(fresh.configPath, sessionID)
            }
            continue
          }

          if (action === "add-file") {
            const already = new Set(profile.envFiles)
            const available = fresh.availableEnvFiles.filter((file) => !already.has(file))
            const choice = await context.ui.dialog.select({
              title: `Add .env file to "${name}"`,
              options: [
                ...available.map((file) => ({ title: file, value: file })),
                { title: "Enter a path…", value: CUSTOM },
              ],
            })
            if (!choice) continue
            const file =
              choice === CUSTOM
                ? (
                    await context.ui.dialog.prompt({
                      title: "Path to .env file",
                      placeholder: ".env.local",
                      value: ".env.local",
                    })
                  )?.trim()
                : choice
            if (!file) continue
            await call("addEnvFile", { profile: name, path: file, baseEnv: terminalEnv }, sessionID)
            await afterProfileEdit(sessionID, [name], name)
          }

          if (action === "remove-file") {
            const file = await context.ui.dialog.select({
              title: `Remove .env file from "${name}"`,
              options: profile.envFiles.map((item) => ({ title: item, value: item })),
            })
            if (!file) continue
            await call("removeEnvFile", { profile: name, path: file, baseEnv: terminalEnv }, sessionID)
            await afterProfileEdit(sessionID, [name], name)
          }

          if (action === "clear-files") {
            const confirmed = await context.ui.dialog.confirm({
              title: "Clear .env files",
              message: `Stop loading all .env files for "${name}"?`,
              label: { confirm: "Clear", cancel: "Cancel" },
            })
            if (!confirmed) continue
            await call("clearEnvFiles", { profile: name, baseEnv: terminalEnv }, sessionID)
            await afterProfileEdit(sessionID, [name], name)
          }

          if (action === "rename") {
            const renamed: string | undefined = (await context.ui.dialog.prompt({
              title: `Rename "${name}"`,
              placeholder: "new-profile-name",
              value: name,
            }))?.trim()
            if (!renamed || renamed === name) continue
            await call("renameProfile", { from: name, to: renamed, baseEnv: terminalEnv }, sessionID)
            await afterProfileEdit(sessionID, [name, renamed], renamed)
            return
          }
        } catch (error) {
          toastError("Profile update failed", error)
        }
      }
    }

    async function manageProfiles(sessionID: string | undefined, state: EnvState) {
      const action = await context.ui.dialog.select({
        title: "Manage profiles",
        options: [
          { title: "Create profile…", value: "create" },
          { title: "Copy profile…", value: "copy" },
          { title: "Rename profile…", value: "rename" },
          { title: "Delete profile…", value: "delete" },
          { title: "Set default profile for new sessions…", value: "default" },
        ],
      })
      if (!action) return

      try {
        if (action === "create") {
          const name = (await context.ui.dialog.prompt({
            title: "New profile",
            placeholder: "dev",
          }))?.trim()
          if (!name) return
          await call("createProfile", { name, baseEnv: terminalEnv }, sessionID)
          toast(`Created profile "${name}"`, "success")
          if (sessionID && (await context.ui.dialog.confirm({ title: "Switch session?", message: `Use "${name}" in this session now?` }))) {
            const switched = await call("setProfile", { sessionID, profile: name, baseEnv: terminalEnv }, sessionID)
            await applyState(sessionID, switched as EnvState)
          }
          return
        }

        if (action === "copy") {
          const from = await pickProfile(state, "Copy which profile?")
          if (!from) return
          const to = (await context.ui.dialog.prompt({
            title: `Copy "${from}" to`,
            placeholder: `${from}-copy`,
          }))?.trim()
          if (!to) return
          await call("copyProfile", { from, to, baseEnv: terminalEnv }, sessionID)
          toast(`Copied "${from}" to "${to}"`, "success")
          return
        }

        if (action === "rename") {
          const from = await pickProfile(state, "Rename which profile?")
          if (!from) return
          const to = (await context.ui.dialog.prompt({
            title: `Rename "${from}"`,
            placeholder: from,
            value: from,
          }))?.trim()
          if (!to || to === from) return
          await call("renameProfile", { from, to, baseEnv: terminalEnv }, sessionID)
          toast(`Renamed "${from}" to "${to}"`, "success")
          const latest = await getState(sessionID)
          if (sessionID && [from, to].includes(latest.profile)) await applyState(sessionID, latest)
          return
        }

        if (action === "delete") {
          const name = await pickProfile(state, "Delete which profile?")
          if (!name) return
          if (name === "default") {
            await context.ui.dialog.alert({ title: "Cannot delete", message: "The default profile is required." })
            return
          }
          const confirmed = await context.ui.dialog.confirm({
            title: `Delete "${name}"?`,
            message: "This removes the profile from the work directory. Sessions using it fall back to the default profile.",
            label: { confirm: "Delete", cancel: "Cancel" },
          })
          if (!confirmed) return
          await call("deleteProfile", { name, baseEnv: terminalEnv }, sessionID)
          toast(`Deleted "${name}"`, "success")
          const latest = await getState(sessionID)
          if (sessionID && latest.profile !== name) await applyState(sessionID, latest)
          return
        }

        if (action === "default") {
          const name = await pickProfile(state, "Default profile for new sessions", state.defaultProfile)
          if (!name) return
          await call("setDefaultProfile", { name, baseEnv: terminalEnv }, sessionID)
          toast(`New sessions will use "${name}"`, "success")
          const use = await context.ui.dialog.confirm({
            title: "Apply now?",
            message: `Switch this session to "${name}" as well?`,
          })
          if (use && sessionID) {
            const switched = await call<EnvState>("setProfile", { sessionID, profile: name, baseEnv: terminalEnv }, sessionID)
            await applyState(sessionID, switched)
          }
          return
        }
      } catch (error) {
        toastError("Profile management failed", error)
      }
    }

    async function openMenu(startSessionID?: string) {
      let sessionID = startSessionID ?? currentSessionID()

      for (;;) {
        let state: EnvState
        try {
          state = await getState(sessionID)
        } catch (error) {
          toastError("Environment", error)
          return
        }

        const hasOverrides = Object.keys(state.overrides.set).length > 0 || state.overrides.unset.length > 0
        const choice = await context.ui.dialog.select({
          title: `Environment — ${state.profile}${sessionID ? "" : " (no session)"}`,
          current: "view",
          options: [
            {
              title: "View combined environment",
              value: "view",
              description: `${state.entries.length} variables${state.unset.length ? `, ${state.unset.length} unset` : ""}${state.warnings.length ? `, ${state.warnings.length} warnings` : ""}`,
              category: "Inspect",
            },
            {
              title: "Switch profile for this session",
              value: "switch",
              description: `Current: ${state.profile}`,
              category: "Profile",
              disabled: !sessionID,
            },
            { title: "Edit profile…", value: "edit", category: "Profile" },
            { title: "Manage profiles…", value: "manage", category: "Profile" },
            {
              title: "Set session-only override…",
              value: "override",
              category: "Session",
              disabled: !sessionID,
            },
            {
              title: "Unset variable for this session…",
              value: "unset",
              category: "Session",
              disabled: !sessionID,
            },
            {
              title: "Clear session overrides",
              value: "clear",
              category: "Session",
              disabled: !sessionID || !hasOverrides,
            },
            {
              title: "Reapply to current session",
              value: "apply",
              category: "Session",
              disabled: !sessionID,
            },
            {
              title: "Set default profile for new sessions…",
              value: "default",
              category: "Defaults",
            },
            {
              title: "Secret store status…",
              value: "secret-store",
              description: state.secretStore.configured
                ? `${state.secretStore.stores.length} layer${state.secretStore.stores.length === 1 ? "" : "s"} · ${state.secrets.length} bound`
                : "not configured",
              category: "Secrets",
            },
            { title: "Reload config from disk", value: "reload", category: "Defaults" },
          ],
        })
        if (!choice) return

        try {
          if (choice === "view") {
            await viewEnvironment(state)
          }

          if (choice === "switch") {
            if (!sessionID) continue
            const profile = await pickProfile(state, "Profile for this session", state.profile)
            if (!profile) continue
            const next = await call<EnvState>("setProfile", { sessionID, profile, baseEnv: terminalEnv }, sessionID)
            await applyState(sessionID, next)
          }

          if (choice === "edit") {
            await editProfile(sessionID, state)
          }

          if (choice === "manage") {
            await manageProfiles(sessionID, state)
          }

          if (choice === "override") {
            if (!sessionID) continue
            const key = (await context.ui.dialog.prompt({
              title: "Session-only variable",
              description: "This override is not saved to any profile.",
              placeholder: "DEBUG",
            }))?.trim()
            if (!key) continue
            const value = await context.ui.dialog.prompt({
              title: `Session-only value for ${key}`,
              placeholder: "true",
              value: state.environment[key] ?? "",
            })
            if (value === undefined) continue
            const next = await call<EnvState>("setOverride", { sessionID, key, value, baseEnv: terminalEnv }, sessionID)
            await applyState(sessionID, next)
          }

          if (choice === "unset") {
            if (!sessionID) continue
            const options = state.entries.map((entry) => ({
              title: entry.key,
              value: entry.key,
              description: `${sourceLabel(entry.source)} · ${truncate(visibleValue(entry, false), 60)}`,
            }))
            options.unshift({ title: "Enter another variable name…", value: CUSTOM, description: "" })
            const picked = await context.ui.dialog.select({
              title: "Unset for this session",
              options,
            })
            if (!picked) continue
            const key =
              picked === CUSTOM
                ? (await context.ui.dialog.prompt({ title: "Variable name to unset", placeholder: "DEBUG" }))?.trim()
                : picked
            if (!key) continue
            const next = await call<EnvState>("unsetKey", { sessionID, key, baseEnv: terminalEnv }, sessionID)
            await applyState(sessionID, next)
          }

          if (choice === "clear") {
            if (!sessionID) continue
            const confirmed = await context.ui.dialog.confirm({
              title: "Clear session overrides",
              message: "Remove all session-only overrides from this session?",
              label: { confirm: "Clear", cancel: "Cancel" },
            })
            if (!confirmed) continue
            const next = await call<EnvState>("clearOverrides", { sessionID, baseEnv: terminalEnv }, sessionID)
            await applyState(sessionID, next)
          }

          if (choice === "apply") {
            if (!sessionID) continue
            const next = await getState(sessionID)
            await applyState(sessionID, next)
          }

          if (choice === "default") {
            const profile = await pickProfile(state, "Default profile for new sessions", state.defaultProfile)
            if (!profile) continue
            await call("setDefaultProfile", { name: profile, baseEnv: terminalEnv }, sessionID)
            toast(`New sessions will use "${profile}"`, "success")
          }

          if (choice === "reload") {
            const next = await call<EnvState>("reload", { sessionID, baseEnv: terminalEnv }, sessionID)
            toast(`Reloaded ${next.configPath}`, "success")
          }

          if (choice === "secret-store") {
            await showSecretStoreStatus(state.configPath)
          }
        } catch (error) {
          toastError("Environment action failed", error)
        }
      }
    }

    const unregisterSlot = context.ui.slot({
      append: "session.composer.top",
      render: (props) => {
        createEffect(
          on(
            () => props.sessionID,
            (sessionID) => {
              if (sessionID) void ensureApplied(sessionID)
            },
            { defer: false },
          ),
        )
        return null as any
      },
    })

    const unsubscribeCreated = context.data.on("session.created", (event: any) => {
      const sessionID = event?.data?.sessionID
      if (typeof sessionID === "string") void ensureApplied(sessionID, event?.location)
    })

    // The TUI seeds a new session with the terminal environment. Reapply at the
    // start of each execution so profile values survive that seed and any later
    // environment replacement.
    const unsubscribeStarted = context.data.on("session.execution.started", (event: any) => {
      const sessionID = event?.data?.sessionID
      if (typeof sessionID === "string") void reapply(sessionID, event?.location)
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "env.manager.menu",
          title: "Environment profiles",
          description: "View and manage environment profiles for this session",
          group: "Environment",
          palette: true,
          slash: { name: "env", aliases: ["envs"] },
          run: async () => {
            try {
              await openMenu()
            } catch (error) {
              toastError("Environment", error)
            }
          },
        },
      ],
    }))

    const sessionID = currentSessionID()
    if (sessionID) void ensureApplied(sessionID)

    return () => {
      unregisterSlot()
      unsubscribeCreated()
      unsubscribeStarted()
    }
  },
})

function snapshotEnvironment(): Record<string, string> | undefined {
  try {
    const environment = (globalThis as any)?.process?.env
    if (!environment || typeof environment !== "object") return undefined
    const snapshot: Record<string, string> = {}
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string") snapshot[key] = value
    }
    return snapshot
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
