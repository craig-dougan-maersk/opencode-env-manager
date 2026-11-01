import fs from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  DEFAULT_PROFILE,
  ensureConfig,
  loadConfig,
  newProfile,
  profileConfigPath,
  saveConfig,
  scanEnvFiles,
  validateEnvKey,
  validateProfileName,
  type Config,
  type Profile,
} from "./config.js"
import { resolveEnvironment, type Entry, type UnsetEntry } from "./resolve.js"
import { EnvManager } from "./rpc.js"
import {
  Vault,
  describeLayer,
  effectiveLayers,
  emptyVault,
  isValidEntryName,
  readGlobalLayers,
  referencedSecrets,
} from "./vault.js"

interface Runtime {
  profile?: string
  set: Record<string, string>
  unset: Set<string>
}

interface State {
  directory: string
  configPath: string
  sessionID: string | null
  profile: string
  defaultProfile: string
  profiles: Array<{
    name: string
    description?: string
    variableCount: number
    variables: Record<string, string>
    envFiles: string[]
    active: boolean
    isDefault: boolean
  }>
  envFiles: Array<{ path: string; exists: boolean }>
  availableEnvFiles: string[]
  environment: Record<string, string>
  entries: Entry[]
  unset: UnsetEntry[]
  warnings: string[]
  overrides: { set: Record<string, string>; unset: string[] }
  secrets: Array<{ name: string; entry: string }>
  vault: {
    configured: boolean
    stores: string[]
    ttlSeconds: number
  }
}

interface SessionInput {
  sessionID?: string
  baseEnv?: Record<string, string>
}

export default Plugin.define({
  id: "env.manager",
  async setup(ctx) {
    const directory = ctx.location.directory
    const serverEnv = snapshotEnvironment(process.env)
    const live = new Map<string, Runtime>()
    let config: Config = {
      version: 1,
      defaultProfile: DEFAULT_PROFILE,
      profiles: { [DEFAULT_PROFILE]: newProfile("Default profile") },
      vault: emptyVault(),
    }

    try {
      config = (await ensureConfig(directory)).config
    } catch (error) {
      console.error(`[env-manager] cannot prepare ${profileConfigPath(directory)}:`, error)
    }

    let queue: Promise<unknown> = Promise.resolve()
    function serial<T>(operation: () => Promise<T>): Promise<T> {
      const run = queue.then(operation, operation)
      queue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    async function currentConfig(): Promise<Config> {
      try {
        config = (await loadConfig(directory)).config
        return config
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw new Error(`Cannot load ${profileConfigPath(directory)}: ${messageOf(error)}`)
        }
        config = (await ensureConfig(directory)).config
        return config
      }
    }

    const vaultReader = new Vault(directory, async () => {
      const cfg = await currentConfig()
      const global = await readGlobalLayers()
      return {
        layers: effectiveLayers(cfg.vault.stores, global.layers),
        ttlSeconds: cfg.vault.ttlSeconds,
        warnings: global.error ? [global.error] : [],
      }
    })

    function storageKey(sessionID: string): string {
      return `session:${directory}:${sessionID}`
    }

    async function runtimeFor(sessionID: string, seen = new Set<string>()): Promise<Runtime> {
      const existing = live.get(sessionID)
      if (existing) return existing
      if (seen.has(sessionID)) return { set: {}, unset: new Set() }
      seen.add(sessionID)

      let storedProfile: string | undefined
      try {
        const stored = (await ctx.storage.get(storageKey(sessionID))) as any
        if (typeof stored?.profile === "string") storedProfile = stored.profile
      } catch {
        // Storage is an optimisation for restoring a selection; ignore failures.
      }

      let parent: Runtime | undefined
      try {
        const session = await ctx.session.get({ sessionID })
        if (session?.parentID) parent = await runtimeFor(session.parentID, seen)
      } catch {
        // A session that is not visible yet simply has no parent state.
      }

      const runtime: Runtime = {
        profile: storedProfile ?? parent?.profile,
        set: { ...(parent?.set ?? {}) },
        unset: new Set(parent?.unset ?? []),
      }
      live.set(sessionID, runtime)
      return runtime
    }

    async function state(sessionID: string | undefined, baseEnv?: Record<string, string>): Promise<State> {
      const cfg = await currentConfig()
      const globalVault = await readGlobalLayers()
      const vaultLayers = effectiveLayers(cfg.vault.stores, globalVault.layers)
      const runtime = sessionID ? await runtimeFor(sessionID) : { set: {}, unset: new Set<string>() }
      const requested = runtime.profile ?? cfg.defaultProfile
      const profileName = cfg.profiles[requested] ? requested : cfg.defaultProfile
      const profile = cfg.profiles[profileName] ?? cfg.profiles[DEFAULT_PROFILE]!
      const base = baseEnv && typeof baseEnv === "object" ? snapshotEnvironment(baseEnv) : serverEnv

      const resolved = await resolveEnvironment({
        cwd: directory,
        base,
        profile,
        profileName,
        overrides: { set: runtime.set, unset: runtime.unset },
      })

      const envFiles = await Promise.all(
        profile.envFiles.map(async (file) => ({
          path: file,
          exists: await isFile(path.resolve(directory, file)),
        })),
      )

      return {
        directory,
        configPath: profileConfigPath(directory),
        sessionID: sessionID ?? null,
        profile: profileName,
        defaultProfile: cfg.defaultProfile,
        profiles: Object.entries(cfg.profiles).map(([name, item]) => ({
          name,
          description: item.description,
          variableCount: Object.keys(item.variables).length,
          secretCount: Object.keys(item.secrets ?? {}).length,
          variables: { ...item.variables },
          secrets: { ...(item.secrets ?? {}) },
          envFiles: [...item.envFiles],
          active: name === profileName,
          isDefault: name === cfg.defaultProfile,
        })),
        envFiles,
        availableEnvFiles: await scanEnvFiles(directory),
        environment: resolved.variables,
        entries: resolved.entries,
        unset: resolved.unset,
        warnings: globalVault.error ? [...resolved.warnings, globalVault.error] : resolved.warnings,
        overrides: { set: { ...runtime.set }, unset: [...runtime.unset] },
        secrets: Object.entries(profile.secrets ?? {})
          .map(([name, entry]) => ({ name, entry }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        vault: {
          configured: vaultLayers.length > 0,
          stores: vaultLayers.map((layer) => describeLayer(layer, directory)),
          ttlSeconds: cfg.vault.ttlSeconds,
        },
      }
    }

    async function mutate(
      sessionID: string | undefined,
      baseEnv: Record<string, string> | undefined,
      change: (next: Config) => void | Promise<void>,
      after?: () => Promise<void>,
    ): Promise<State> {
      return serial(async () => {
        const cfg = await currentConfig()
        const next = structuredClone(cfg)
        await change(next)
        await saveConfig(directory, next)
        config = next
        vaultReader.invalidate()
        if (after) await after()
        return state(sessionID, baseEnv)
      })
    }

    function requireProfile(cfg: Config, name: string): Profile {
      const profile = cfg.profiles[name]
      if (!profile) throw new Error(`Unknown profile: ${name}`)
      return profile
    }

    async function migrateSessions(from: string, to: string | undefined): Promise<void> {
      for (const runtime of live.values()) {
        if (runtime.profile === from) runtime.profile = to
      }

      let cursor: string | undefined
      for (;;) {
        const page = await ctx.storage.scan({ prefix: `session:${directory}:`, limit: 100, after: cursor })
        for (const entry of page.entries) {
          const value = entry.value as any
          if (value?.profile !== from) continue
          await ctx.storage.set(entry.key, to ? { ...value, profile: to } : {})
        }
        cursor = page.next
        if (!cursor) break
      }
    }

    const handlers = {
      state: async (input: unknown) => {
        const value = input as SessionInput
        return state(value.sessionID, value.baseEnv)
      },
      resolve: async (input: unknown) => {
        const value = input as SessionInput
        return state(value.sessionID, value.baseEnv)
      },
      // Name only: other plugins can follow the active profile without
      // receiving the resolved environment or any secret values.
      activeProfile: async (input: unknown) => {
        const value = input as { sessionID?: string }
        const profile = await activeProfile(value.sessionID)
        return { profile: profile.name, defaultProfile: config.defaultProfile }
      },
      setProfile: async (input: unknown) => {
        const value = input as { sessionID: string; profile: string; baseEnv?: Record<string, string> }
        return serial(async () => {
          const cfg = await currentConfig()
          requireProfile(cfg, value.profile)
          const runtime = await runtimeFor(value.sessionID)
          runtime.profile = value.profile
          await ctx.storage.set(storageKey(value.sessionID), { profile: value.profile })
          return state(value.sessionID, value.baseEnv)
        })
      },
      setOverride: async (input: unknown) => {
        const value = input as { sessionID: string; key: string; value: string; baseEnv?: Record<string, string> }
        return serial(async () => {
          const key = validateEnvKey(value.key)
          const runtime = await runtimeFor(value.sessionID)
          runtime.set[key] = value.value
          runtime.unset.delete(key)
          return state(value.sessionID, value.baseEnv)
        })
      },
      unsetKey: async (input: unknown) => {
        const value = input as { sessionID: string; key: string; baseEnv?: Record<string, string> }
        return serial(async () => {
          const key = validateEnvKey(value.key)
          const runtime = await runtimeFor(value.sessionID)
          delete runtime.set[key]
          runtime.unset.add(key)
          return state(value.sessionID, value.baseEnv)
        })
      },
      clearOverrides: async (input: unknown) => {
        const value = input as SessionInput
        if (!value.sessionID) throw new Error("A session is required")
        return serial(async () => {
          const runtime = await runtimeFor(value.sessionID!)
          runtime.set = {}
          runtime.unset = new Set()
          return state(value.sessionID, value.baseEnv)
        })
      },
      createProfile: async (input: unknown) => {
        const value = input as { name: string; from?: string; baseEnv?: Record<string, string> }
        const name = validateProfileName(value.name)
        return mutate(undefined, value.baseEnv, (next) => {
          if (next.profiles[name]) throw new Error(`Profile already exists: ${name}`)
          if (value.from) {
            const source = requireProfile(next, value.from)
            next.profiles[name] = {
              ...structuredClone(source),
              description: source.description ?? `Copied from ${value.from}`,
            }
          } else {
            next.profiles[name] = newProfile(`Profile ${name}`)
          }
        })
      },
      copyProfile: async (input: unknown) => {
        const value = input as { from: string; to: string; baseEnv?: Record<string, string> }
        const to = validateProfileName(value.to)
        return mutate(undefined, value.baseEnv, (next) => {
          if (next.profiles[to]) throw new Error(`Profile already exists: ${to}`)
          const source = requireProfile(next, value.from)
          next.profiles[to] = {
            ...structuredClone(source),
            description: source.description ?? `Copied from ${value.from}`,
          }
        })
      },
      renameProfile: async (input: unknown) => {
        const value = input as { from: string; to: string; baseEnv?: Record<string, string> }
        const to = validateProfileName(value.to)
        return mutate(
          undefined,
          value.baseEnv,
          (next) => {
            requireProfile(next, value.from)
            if (next.profiles[to]) throw new Error(`Profile already exists: ${to}`)
            const rebuilt: Record<string, Profile> = {}
            for (const [name, profile] of Object.entries(next.profiles)) {
              rebuilt[name === value.from ? to : name] = profile
            }
            next.profiles = rebuilt
            if (next.defaultProfile === value.from) next.defaultProfile = to
          },
          () => migrateSessions(value.from, to),
        )
      },
      deleteProfile: async (input: unknown) => {
        const value = input as { name: string; baseEnv?: Record<string, string> }
        const name = validateProfileName(value.name)
        return mutate(
          undefined,
          value.baseEnv,
          (next) => {
            if (name === DEFAULT_PROFILE) throw new Error("The default profile cannot be deleted")
            requireProfile(next, name)
            delete next.profiles[name]
            if (next.defaultProfile === name) next.defaultProfile = DEFAULT_PROFILE
          },
          () => migrateSessions(name, undefined),
        )
      },
      setVariable: async (input: unknown) => {
        const value = input as { profile: string; key: string; value: string; baseEnv?: Record<string, string> }
        const key = validateEnvKey(value.key)
        return mutate(undefined, value.baseEnv, (next) => {
          const profile = requireProfile(next, value.profile)
          profile.variables[key] = value.value
        })
      },
      removeVariable: async (input: unknown) => {
        const value = input as { profile: string; key: string; baseEnv?: Record<string, string> }
        const key = validateEnvKey(value.key)
        return mutate(undefined, value.baseEnv, (next) => {
          const profile = requireProfile(next, value.profile)
          delete profile.variables[key]
        })
      },
      setSecret: async (input: unknown) => {
        const value = input as { profile: string; name: string; entry: string; baseEnv?: Record<string, string> }
        const name = validateEnvKey(value.name)
        const entry = value.entry.trim()
        if (!isValidEntryName(entry)) {
          throw new Error("Vault entry names may contain letters, digits, dots, dashes, slashes and underscores")
        }
        return mutate(undefined, value.baseEnv, (next) => {
          requireProfile(next, value.profile).secrets[name] = entry
        })
      },
      removeSecret: async (input: unknown) => {
        const value = input as { profile: string; name: string; baseEnv?: Record<string, string> }
        const name = validateEnvKey(value.name)
        return mutate(undefined, value.baseEnv, (next) => {
          delete requireProfile(next, value.profile).secrets[name]
        })
      },
      vaultStatus: async () => vaultReader.status(),
      vaultGet: async (input: unknown) => {
        const value = input as { entries?: unknown }
        if (!Array.isArray(value?.entries)) throw new Error("entries must be an array")
        if (value.entries.length > 64) throw new Error("At most 64 vault entries may be requested at once")
        const entries: string[] = []
        for (const item of value.entries) {
          if (typeof item !== "string") throw new Error("Vault entry names must be strings")
          const entry = item.trim()
          if (!isValidEntryName(entry)) {
            throw new Error(`Invalid vault entry name: ${entry}`)
          }
          if (!entries.includes(entry)) entries.push(entry)
        }
        if (!entries.length) {
          return { values: {}, missing: [], warnings: [], searched: [] }
        }

        const resolved = await vaultReader.resolve(
          Object.fromEntries(entries.map((entry) => [entry, entry])),
        )
        return {
          values: resolved.values,
          missing: resolved.missing,
          warnings: resolved.warnings,
          searched: resolved.searched,
        }
      },
      addEnvFile: async (input: unknown) => {
        const value = input as { profile: string; path: string; baseEnv?: Record<string, string> }
        const file = value.path.trim()
        if (!file) throw new Error("Env file path cannot be empty")
        return mutate(undefined, value.baseEnv, (next) => {
          const profile = requireProfile(next, value.profile)
          if (!profile.envFiles.includes(file)) profile.envFiles.push(file)
        })
      },
      removeEnvFile: async (input: unknown) => {
        const value = input as { profile: string; path: string; baseEnv?: Record<string, string> }
        return mutate(undefined, value.baseEnv, (next) => {
          const profile = requireProfile(next, value.profile)
          profile.envFiles = profile.envFiles.filter((file) => file !== value.path)
        })
      },
      clearEnvFiles: async (input: unknown) => {
        const value = input as { profile: string; baseEnv?: Record<string, string> }
        return mutate(undefined, value.baseEnv, (next) => {
          requireProfile(next, value.profile).envFiles = []
        })
      },
      setDefaultProfile: async (input: unknown) => {
        const value = input as { name: string; baseEnv?: Record<string, string> }
        return mutate(undefined, value.baseEnv, (next) => {
          requireProfile(next, value.name)
          next.defaultProfile = value.name
        })
      },
      reload: async (input: unknown) => {
        const value = input as SessionInput
        return serial(async () => state(value.sessionID, value.baseEnv))
      },
    }

    await ctx.rpc.register(EnvManager, handlers)

    // ---- Vault-backed secrets -------------------------------------------------
    // Approve in tool.execute.before (which has the session) and inject in
    // shell.create.before (which has the spawned command's environment). A
    // secret therefore never enters the session environment, only the env of
    // the single command that referenced it.

    const grants = new Map<string, Array<{ expires: number; values: Record<string, string> }>>()
    const GRANT_TTL_MS = 30_000

    function pruneGrants(now: number) {
      for (const [key, list] of grants) {
        const live = list.filter((grant) => grant.expires > now)
        if (live.length) grants.set(key, live)
        else grants.delete(key)
      }
    }

    function addGrant(command: string, values: Record<string, string>) {
      pruneGrants(Date.now())
      const list = grants.get(command) ?? []
      list.push({ expires: Date.now() + GRANT_TTL_MS, values })
      grants.set(command, list)
    }

    function takeGrant(command: string): Record<string, string> | undefined {
      pruneGrants(Date.now())

      const exact = grants.get(command)
      if (exact?.length) {
        const grant = exact.shift()!
        if (!exact.length) grants.delete(command)
        return grant.values
      }

      // The shell tool may wrap or prefix the command, so fall back to the
      // longest granted command contained in the spawned text.
      const candidates = [...grants.keys()].filter((key) => command.includes(key)).sort((left, right) => right.length - left.length)
      for (const key of candidates) {
        const list = grants.get(key)!
        const grant = list.shift()!
        if (!list.length) grants.delete(key)
        return grant.values
      }

      return undefined
    }

    async function activeProfile(sessionID: string | undefined): Promise<{ name: string; secrets: Record<string, string> }> {
      const cfg = await currentConfig()
      const runtime = sessionID ? await runtimeFor(sessionID) : undefined
      const requested = runtime?.profile ?? cfg.defaultProfile
      const name = cfg.profiles[requested] ? requested : cfg.defaultProfile
      const profile = cfg.profiles[name] ?? cfg.profiles[DEFAULT_PROFILE]!
      return { name, secrets: profile.secrets ?? {} }
    }

    const shellToolHook = await ctx.tool.hook("execute.before", async (event) => {
      const tool = String(event.tool ?? "").toLowerCase()
      if (tool !== "shell" && tool !== "bash") return

      const command = commandOf(event.input)
      if (!command) return

      const profile = await activeProfile(event.sessionID)
      const names = referencedSecrets(command, profile.secrets)
      if (!names.length) return

      await ctx.permission.assert({
        sessionID: event.sessionID,
        agent: event.agent,
        action: "secret.use",
        resources: names,
        save: [],
        metadata: {
          command,
          profile: profile.name,
          entries: Object.fromEntries(names.map((name) => [name, profile.secrets[name]])),
        },
        source: { type: "tool", messageID: event.messageID, id: event.id },
      })

      const resolved = await vaultReader.resolve(
        Object.fromEntries(names.map((name) => [name, profile.secrets[name]!])),
      )
      if (resolved.missing.length) {
        const searched = resolved.searched.length
          ? ` Searched: ${resolved.searched.join(", ")}.`
          : " No vault layers resolved."
        throw new Error(
          `Vault entry not found: ${resolved.missing.join(", ")}.${searched} Fix the binding in ${profileConfigPath(directory)}.`,
        )
      }

      addGrant(command, resolved.values)
    })

    const shellEnvHook = await ctx.shell.hook("create.before", (event) => {
      const values = takeGrant(event.command)
      if (!values) return
      for (const [name, value] of Object.entries(values)) event.env[name] = value
    })

    const secretsTool = await ctx.tool.transform((editor) => {
      editor.add({
        name: "env_secrets",
        description:
          "List the vault-backed environment variables bound to the current profile. Values are never returned. " +
          "Reference a listed name as $NAME or ${NAME} in a shell command and its value is injected for that single " +
          "command only, after the user approves it. Never echo, print or log these values.",
        input: { type: "object", properties: {}, additionalProperties: false } as const,
        execute: async (_input: unknown, context: any) => {
          const profile = await activeProfile(context?.sessionID)
          const entries = Object.entries(profile.secrets).sort(([left], [right]) => left.localeCompare(right))
          if (!entries.length) {
            return { content: `Profile "${profile.name}" has no vault-backed variables.` }
          }
          return {
            content: [
              `Profile "${profile.name}" injects these variables per command:`,
              ...entries.map(([name, entry]) => `- $${name} (vault entry ${entry})`),
              "",
              "Use $NAME or ${NAME} in a shell command to have it set for that one command.",
              "The value never enters the session environment and is never returned to you. Do not echo or print it.",
            ].join("\n"),
          }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
        const sessionID = (event as any).data?.sessionID
        if (typeof sessionID !== "string") continue
        live.delete(sessionID)
        await ctx.storage.remove(storageKey(sessionID)).catch(() => undefined)
      }
    })().catch(() => undefined)

    return () => {
      controller.abort()
      void shellToolHook.dispose()
      void shellEnvHook.dispose()
      void secretsTool.dispose()
    }
  },
})

function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return undefined
}

function snapshotEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") snapshot[key] = value
  }
  return snapshot
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
