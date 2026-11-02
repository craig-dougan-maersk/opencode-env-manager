import fs from "node:fs/promises"
import path from "node:path"
import { emptySecretStore, isValidSecretBinding, normalizeSecretStore, type SecretStoreConfig } from "./secret-store.js"

export const DEFAULT_PROFILE = "default"
export const DEFAULT_ENV_FILE = ".env"
export const CONFIG_DIRECTORY = ".opencode"
export const CONFIG_FILENAME = "env-profiles.json"

export interface Profile {
  description?: string
  envFiles: string[]
  variables: Record<string, string>
  /** Environment variable name -> entry name inside the secret store. */
  secrets: Record<string, string>
}

export interface Config {
  version: 1
  defaultProfile: string
  profiles: Record<string, Profile>
  secretStore: SecretStoreConfig
}

export interface LoadedConfig {
  config: Config
  path: string
  created: boolean
}

export function profileConfigPath(directory: string): string {
  return path.join(directory, CONFIG_DIRECTORY, CONFIG_FILENAME)
}

export function newProfile(description?: string): Profile {
  return {
    description,
    envFiles: [DEFAULT_ENV_FILE],
    variables: {},
    secrets: {},
  }
}

export function defaultConfig(): Config {
  return {
    version: 1,
    defaultProfile: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: newProfile("Default profile"),
    },
    secretStore: emptySecretStore(),
  }
}

export function isEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

export function validateProfileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("Profile name cannot be empty")
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error("Profile names may only contain letters, digits, dots, dashes and underscores")
  }
  return trimmed
}

export function validateEnvKey(key: string): string {
  const trimmed = key.trim()
  if (!isEnvKey(trimmed)) {
    throw new Error("Variable names must start with a letter or underscore and contain only letters, digits and underscores")
  }
  return trimmed
}

export async function loadConfig(directory: string): Promise<LoadedConfig> {
  const file = profileConfigPath(directory)
  const text = await fs.readFile(file, "utf8")
  const raw = JSON.parse(text.replace(/^\uFEFF/, ""))
  return { config: normalizeConfig(raw), path: file, created: false }
}

export async function ensureConfig(directory: string): Promise<LoadedConfig> {
  try {
    return await loadConfig(directory)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
    const config = defaultConfig()
    await saveConfig(directory, config)
    return { config, path: profileConfigPath(directory), created: true }
  }
}

export async function saveConfig(directory: string, config: Config): Promise<void> {
  const file = profileConfigPath(directory)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function normalizeConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error("Profile config must be a JSON object")

  const profiles: Record<string, Profile> = {}
  const source = isRecord(raw.profiles) ? raw.profiles : {}
  for (const [name, value] of Object.entries(source)) {
    if (!isProfileName(name)) continue
    profiles[name] = normalizeProfile(value)
  }

  if (!profiles[DEFAULT_PROFILE]) profiles[DEFAULT_PROFILE] = newProfile("Default profile")

  // Keep the default profile first for a stable menu order.
  const ordered: Record<string, Profile> = {}
  ordered[DEFAULT_PROFILE] = profiles[DEFAULT_PROFILE]
  for (const [name, profile] of Object.entries(profiles)) {
    if (name !== DEFAULT_PROFILE) ordered[name] = profile
  }

  const requested = typeof raw.defaultProfile === "string" ? raw.defaultProfile : DEFAULT_PROFILE
  const defaultProfile = ordered[requested] ? requested : DEFAULT_PROFILE

  // `secretStore` is current; `vault` is the pre-rename key, still read once and
  // rewritten as `secretStore` on the next save.
  const secretStore = raw.secretStore !== undefined ? raw.secretStore : raw.vault

  return { version: 1, defaultProfile, profiles: ordered, secretStore: normalizeSecretStore(secretStore) }
}

function normalizeProfile(value: unknown): Profile {
  const data = isRecord(value) ? value : {}
  const envFiles = Array.isArray(data.envFiles)
    ? data.envFiles.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [DEFAULT_ENV_FILE]

  const variables: Record<string, string> = {}
  if (isRecord(data.variables)) {
    for (const [key, rawValue] of Object.entries(data.variables)) {
      if (!isEnvKey(key)) continue
      if (rawValue === undefined || rawValue === null) continue
      variables[key] = typeof rawValue === "string" ? rawValue : String(rawValue)
    }
  }

  const secrets: Record<string, string> = {}
  if (isRecord(data.secrets)) {
    for (const [name, entry] of Object.entries(data.secrets)) {
      if (typeof entry !== "string") continue
      if (!isValidSecretBinding(name, entry.trim())) continue
      secrets[name] = entry.trim()
    }
  }

  return {
    description: typeof data.description === "string" ? data.description : undefined,
    envFiles: [...new Set(envFiles)],
    variables,
    secrets,
  }
}

export async function scanEnvFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && (entry.name === DEFAULT_ENV_FILE || entry.name.startsWith(`${DEFAULT_ENV_FILE}.`)))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isProfileName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value)
}
