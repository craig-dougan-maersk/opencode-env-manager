import fs from "node:fs/promises"
import path from "node:path"
import type { Profile } from "./config.js"
import { DEFAULT_ENV_FILE } from "./config.js"
import { expandValue, parseDotEnv } from "./dotenv.js"

export type Source = "parent" | `file:${string}` | `profile:${string}` | "session"

export interface Entry {
  key: string
  value: string
  source: Source
  chain: Source[]
}

export interface UnsetEntry {
  key: string
  source: Source
}

export interface Resolved {
  variables: Record<string, string>
  entries: Entry[]
  unset: UnsetEntry[]
  warnings: string[]
}

interface Layer {
  value: string
  source: Source
  chain: Source[]
}

export interface ResolveInput {
  cwd: string
  base: Record<string, string>
  profile: Profile
  profileName: string
  overrides?: {
    set?: Record<string, string>
    unset?: Iterable<string>
  }
}

export async function resolveEnvironment(input: ResolveInput): Promise<Resolved> {
  const warnings: string[] = []
  const layers = new Map<string, Layer>()

  for (const [key, value] of Object.entries(input.base)) {
    layers.set(key, { value, source: "parent", chain: ["parent"] })
  }

  for (const file of input.profile.envFiles) {
    const absolute = path.resolve(input.cwd, file)
    let text: string
    try {
      text = await fs.readFile(absolute, "utf8")
    } catch (error: any) {
      if (error?.code === "ENOENT" && (file === DEFAULT_ENV_FILE || file === `./${DEFAULT_ENV_FILE}`)) continue
      warnings.push(`cannot read env file ${file}: ${error?.message ?? String(error)}`)
      continue
    }

    const parsed = parseDotEnv(text, currentEnv(layers))
    for (const warning of parsed.warnings) warnings.push(`${file}: ${warning}`)
    for (const [key, value] of Object.entries(parsed.values)) {
      apply(layers, key, value, `file:${file}`)
    }
  }

  for (const [key, raw] of Object.entries(input.profile.variables)) {
    apply(layers, key, expandValue(raw, currentEnv(layers), { bracedOnly: true }), `profile:${input.profileName}`)
  }

  for (const [key, raw] of Object.entries(input.overrides?.set ?? {})) {
    apply(layers, key, expandValue(raw, currentEnv(layers), { bracedOnly: true }), "session")
  }

  const unset: UnsetEntry[] = []
  for (const key of input.overrides?.unset ?? []) {
    const previous = layers.get(key)
    unset.push({ key, source: previous?.source ?? "parent" })
    layers.delete(key)
  }

  const variables: Record<string, string> = {}
  const entries: Entry[] = []
  for (const key of [...layers.keys()].sort((left, right) => left.localeCompare(right))) {
    const layer = layers.get(key)!
    variables[key] = layer.value
    entries.push({ key, value: layer.value, source: layer.source, chain: layer.chain })
  }

  return { variables, entries, unset, warnings }
}

function apply(layers: Map<string, Layer>, key: string, value: string, source: Source) {
  const previous = layers.get(key)
  const chain = previous ? [...previous.chain.filter((item) => item !== source), source] : [source]
  layers.set(key, { value, source, chain })
}

function currentEnv(layers: Map<string, Layer>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, layer] of layers) env[key] = layer.value
  return env
}
