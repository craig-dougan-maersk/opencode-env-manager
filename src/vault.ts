import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

export const DEFAULT_PROVIDER = ["age", "--decrypt", "--identity", "{keyFile}", "{store}"]
export const DEFAULT_TTL_SECONDS = 60
export const DEFAULT_TIMEOUT_MS = 15_000

const ENTRY_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface VaultLayer {
  /** argv template; `{store}`, `{keyFile}` and `{cwd}` are substituted. Empty uses age. */
  provider: string[]
  /** Encrypted file, absolute, home-relative or work-directory relative. */
  store?: string
  /** Private key / identity file for the default age provider. */
  keyFile?: string
}

export interface VaultConfig {
  /** Ordered layers. Earlier layers win; later layers are inherited fallbacks. */
  stores: VaultLayer[]
  /** How long a decrypted copy may stay in memory, in seconds. 0 disables caching. */
  ttlSeconds: number
}

export interface LayerStatus {
  store?: string
  provider: string
  ok: boolean
  missing?: boolean
  entries: string[]
  warnings: string[]
  error?: string
}

export interface VaultStatus {
  configured: boolean
  layers: LayerStatus[]
  ok: boolean
  entries: string[]
  warnings: string[]
}

export interface ResolvedSecrets {
  values: Record<string, string>
  missing: string[]
  warnings: string[]
  searched: string[]
}

export interface VaultSource {
  layers: VaultLayer[]
  ttlSeconds: number
  warnings?: string[]
}

class MissingStoreError extends Error {}

export function emptyVault(): VaultConfig {
  return { stores: [], ttlSeconds: DEFAULT_TTL_SECONDS }
}

export function isVaultConfigured(vault: VaultConfig): boolean {
  return vault.stores.length > 0
}

// ---- configuration ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeVault(value: unknown): VaultConfig {
  const data = isRecord(value) ? value : {}
  const stores: VaultLayer[] = []

  if (Array.isArray(data.stores)) {
    for (const item of data.stores) {
      const layer = normalizeLayer(item)
      if (layer) stores.push(layer)
    }
  } else {
    // Backwards compatibility: a single store/provider/keyFile block.
    const single = normalizeLayer(data)
    if (single) stores.push(single)
  }

  const ttlSeconds =
    typeof data.ttlSeconds === "number" && Number.isFinite(data.ttlSeconds) && data.ttlSeconds >= 0
      ? Math.min(Math.floor(data.ttlSeconds), 3600)
      : DEFAULT_TTL_SECONDS

  return { stores, ttlSeconds }
}

function normalizeLayer(value: unknown): VaultLayer | undefined {
  if (!isRecord(value)) return undefined

  const provider = Array.isArray(value.provider)
    ? value.provider
        .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item: string) => item.trim())
    : []
  const store = typeof value.store === "string" && value.store.trim() ? value.store.trim() : undefined
  const keyFile = typeof value.keyFile === "string" && value.keyFile.trim() ? value.keyFile.trim() : undefined

  if (!store && !provider.length) return undefined
  return { provider, store, keyFile }
}

/** Project layers first, then inherited global layers, without duplicates. */
export function effectiveLayers(project: readonly VaultLayer[], global: readonly VaultLayer[]): VaultLayer[] {
  const seen = new Set<string>()
  const result: VaultLayer[] = []
  for (const layer of [...project, ...global]) {
    const key = layerKey(layer)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(layer)
  }
  return result
}

function layerKey(layer: VaultLayer): string {
  return `${layer.provider.join("\u0000")}|${layer.store ?? ""}|${layer.keyFile ?? ""}`
}

export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "env-manager.json")
}

/** Layers every project inherits. Never throws: a broken file is reported by `status`. */
export async function readGlobalLayers(): Promise<{ layers: VaultLayer[]; error?: string }> {
  let text: string
  try {
    text = await fs.readFile(globalConfigPath(), "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") return { layers: [] }
    return { layers: [], error: `Cannot read ${globalConfigPath()}: ${messageOf(error)}` }
  }

  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ""))
    return { layers: normalizeVault(isRecord(raw) ? raw.vault : undefined).stores }
  } catch (error) {
    return { layers: [], error: `Cannot parse ${globalConfigPath()}: ${messageOf(error)}` }
  }
}

// ---- provider plumbing -----------------------------------------------------

/** Expand `~`, `$HOME` and work-directory-relative paths. */
export function expandPath(value: string, directory: string): string {
  const trimmed = value.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2))
  if (trimmed.startsWith("$HOME/")) return path.join(os.homedir(), trimmed.slice(6))
  if (path.isAbsolute(trimmed)) return trimmed
  return path.resolve(directory, trimmed)
}

/**
 * `store` is a file path for the default age provider. With an explicit
 * provider it is whatever the command expects, so only clearly path-shaped
 * values are expanded (`pass` needs the entry name untouched).
 */
export function storeArgument(layer: VaultLayer, directory: string): string {
  const store = layer.store ?? ""
  if (!layer.provider.length) return expandPath(store, directory)
  if (store.startsWith("~") || store.startsWith("$HOME/") || path.isAbsolute(store)) {
    return expandPath(store, directory)
  }
  return store
}

export function layerArgv(layer: VaultLayer, directory: string): string[] {
  if (!layer.store && !layer.provider.length) {
    throw new Error("Vault layer has neither a store nor a provider.")
  }

  const store = storeArgument(layer, directory)
  const keyFile = layer.keyFile ? expandPath(layer.keyFile, directory) : undefined
  const template = layer.provider.length ? layer.provider : DEFAULT_PROVIDER

  if (!layer.provider.length && !keyFile) {
    throw new Error("The default age provider needs keyFile on the layer, or an explicit provider.")
  }

  return template.map((token) =>
    token.replaceAll("{store}", store).replaceAll("{keyFile}", keyFile ?? "").replaceAll("{cwd}", directory),
  )
}

export function describeLayer(layer: VaultLayer, directory: string): string {
  if (layer.provider.length) {
    try {
      return layerArgv(layer, directory).join(" ")
    } catch {
      return layer.provider.join(" ")
    }
  }
  const store = storeArgument(layer, directory)
  return store || DEFAULT_PROVIDER.join(" ")
}

export function isValidEntryName(name: string): boolean {
  return ENTRY_NAME.test(name)
}

export function isValidSecretBinding(name: string, entry: string): boolean {
  return ENV_NAME.test(name) && ENTRY_NAME.test(entry)
}

// ---- parsing ---------------------------------------------------------------

/**
 * Parse a decrypted vault file. Values are taken literally: `$VAR` is never
 * expanded, because credentials routinely contain `$` and backslashes.
 * Quote a value to keep leading/trailing whitespace or to use `#` at the end.
 */
export function parseSecretFile(text: string): { values: Record<string, string>; warnings: string[] } {
  const values: Record<string, string> = {}
  const warnings: string[] = []
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    let line = lines[index].trim()
    if (!line || line.startsWith("#")) continue
    line = line.replace(/^export\s+/i, "").trim()

    const equals = line.indexOf("=")
    if (equals <= 0) {
      warnings.push(`line ${lineNumber}: expected NAME=value`)
      continue
    }

    const key = line.slice(0, equals).trim()
    if (!ENTRY_NAME.test(key)) {
      warnings.push(`line ${lineNumber}: invalid entry name "${key}"`)
      continue
    }

    values[key] = parseLiteralValue(line.slice(equals + 1).trimStart())
  }

  return { values, warnings }
}

function parseLiteralValue(raw: string): string {
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1)
    return end === -1 ? raw.slice(1) : raw.slice(1, end)
  }

  if (raw.startsWith('"')) {
    let value = ""
    for (let index = 1; index < raw.length; index++) {
      const character = raw[index]!
      if (character === "\\") {
        const next = raw[++index]
        if (next === undefined) break
        value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next
      } else if (character === '"') {
        return value
      } else {
        value += character
      }
    }
    return value
  }

  // Unquoted values run to end of line, with no comment stripping and no expansion.
  return raw.trimEnd()
}

/** Names bound in the profile that the command actually references. */
export function referencedSecrets(command: string, bindings: Record<string, string>): string[] {
  const found: string[] = []
  for (const name of Object.keys(bindings)) {
    if (!ENV_NAME.test(name)) continue
    const pattern = new RegExp(`\\$\\{${name}(?::-?[^}]*)?\\}|\\$${name}\\b`)
    if (pattern.test(command)) found.push(name)
  }
  return found.sort()
}

// ---- vault -----------------------------------------------------------------

interface Decrypted {
  at: number
  values: Record<string, string>
  warnings: string[]
}

export class Vault {
  private readonly cache = new Map<string, Decrypted>()

  constructor(
    private readonly directory: string,
    private readonly load: () => Promise<VaultSource>,
  ) {}

  invalidate(): void {
    this.cache.clear()
  }

  private async decryptLayer(layer: VaultLayer, ttl: number, force = false): Promise<Decrypted> {
    const key = layerKey(layer)
    const cached = this.cache.get(key)
    if (!force && ttl > 0 && cached && Date.now() - cached.at < ttl) return cached

    await this.assertReachable(layer)
    const argv = layerArgv(layer, this.directory)
    const [file, ...args] = argv as [string, ...string[]]

    let stdout: string
    try {
      const result = (await run(file, args, {
        cwd: this.directory,
        env: childEnvironment(),
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      } as any)) as unknown as { stdout: string }
      stdout = String(result.stdout ?? "")
    } catch (error) {
      throw new Error(runErrorMessage(file, error))
    }

    const parsed = parseSecretFile(stdout)
    const entry: Decrypted = { at: Date.now(), values: parsed.values, warnings: parsed.warnings }
    this.cache.set(key, entry)
    return entry
  }

  private async assertReachable(layer: VaultLayer): Promise<void> {
    const store = storeArgument(layer, this.directory)
    if (!store) return
    try {
      const stat = await fs.stat(store)
      if (!stat.isFile()) throw new Error(`${store} is not a regular file`)
    } catch (error: any) {
      // With an explicit provider the store may not be a local file at all,
      // so only the file-based default reports a missing store itself.
      if (error?.code === "ENOENT" && !layer.provider.length) {
        throw new MissingStoreError(`Vault store not found: ${store}`)
      }
    }
  }

  async resolve(bindings: Record<string, string>): Promise<ResolvedSecrets> {
    const source = await this.load()
    const pending = new Map(Object.entries(bindings))
    const values: Record<string, string> = {}
    const warnings: string[] = [...(source.warnings ?? [])]
    const searched: string[] = []

    for (const layer of source.layers) {
      if (!pending.size) break

      let decrypted: Decrypted
      try {
        decrypted = await this.decryptLayer(layer, source.ttlSeconds)
      } catch (error) {
        // A checkout that has no project store yet falls through to the
        // inherited layer instead of failing every command.
        if (error instanceof MissingStoreError) {
          warnings.push(error.message)
          continue
        }
        throw error
      }

      searched.push(describeLayer(layer, this.directory))
      for (const [name, entry] of [...pending]) {
        const value = decrypted.values[entry]
        if (value === undefined) continue
        values[name] = value
        pending.delete(name)
      }
    }

    return { values, missing: [...new Set([...pending.values()])], warnings, searched }
  }

  async status(): Promise<VaultStatus> {
    const source = await this.load()
    const status: VaultStatus = {
      configured: source.layers.length > 0,
      layers: [],
      ok: false,
      entries: [],
      warnings: [...(source.warnings ?? [])],
    }

    const merged = new Set<string>()
    for (const layer of source.layers) {
      const item: LayerStatus = {
        store: layer.store,
        provider: describeLayer(layer, this.directory),
        ok: false,
        entries: [],
        warnings: [],
      }

      try {
        const decrypted = await this.decryptLayer(layer, 0, true)
        item.ok = true
        item.entries = Object.keys(decrypted.values).sort()
        item.warnings = decrypted.warnings
        for (const entry of item.entries) merged.add(entry)
      } catch (error) {
        if (error instanceof MissingStoreError) item.missing = true
        item.error = messageOf(error)
      }

      status.layers.push(item)
    }

    status.ok = status.layers.some((layer) => layer.ok)
    status.entries = [...merged].sort()
    return status
  }
}

function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: os.homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: os.tmpdir(),
  }
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
  return env
}

function runErrorMessage(file: string, error: any): string {
  if (error?.code === "ENOENT") {
    return `Vault command not found: ${file}. Install it (for age: sudo apt install age) or set the layer provider.`
  }
  if (error?.killed || error?.signal === "SIGTERM") {
    return `Vault command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s: ${file}`
  }
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
  const detail = stderr || messageOf(error)
  return `Vault command failed (${file}): ${detail}`
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
