export interface DotEnvResult {
  values: Record<string, string>
  warnings: string[]
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse a dotenv file. Supports comments, blank lines, `export KEY=value`,
 * single/double quoted values, escapes in double quotes, inline comments and
 * `$VAR` / `${VAR}` / `${VAR:-fallback}` expansion against `base`.
 *
 * Later assignments win. Values are always strings.
 */
export function parseDotEnv(text: string, base: Record<string, string> = {}): DotEnvResult {
  const values: Record<string, string> = {}
  const warnings: string[] = []
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    let line = lines[index].trim()
    if (!line || line.startsWith("#")) continue

    if (/^export\s+/i.test(line)) {
      line = line.replace(/^export\s+/i, "").trim()
    }

    const equals = line.indexOf("=")
    if (equals <= 0) {
      warnings.push(`line ${lineNumber}: expected KEY=value`)
      continue
    }

    const key = line.slice(0, equals).trim()
    if (!ENV_KEY.test(key)) {
      warnings.push(`line ${lineNumber}: invalid variable name "${key}"`)
      continue
    }

    const raw = line.slice(equals + 1).trim()
    const parsed = parseValue(raw, lineNumber, warnings)
    if (parsed === undefined) continue

    values[key] = expandValue(parsed, { ...base, ...values })
  }

  return { values, warnings }
}

function parseValue(raw: string, lineNumber: number, warnings: string[]): string | undefined {
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1)
    if (end === -1) {
      warnings.push(`line ${lineNumber}: unterminated single-quoted value`)
      return undefined
    }
    warnTrailing(raw.slice(end + 1), lineNumber, warnings)
    return raw.slice(1, end)
  }

  if (raw.startsWith('"')) {
    let value = ""
    let closed = false
    let index = 1
    for (; index < raw.length; index++) {
      const character = raw[index]
      if (character === "\\") {
        const next = raw[++index]
        if (next === undefined) break
        value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next
      } else if (character === '"') {
        closed = true
        index++
        break
      } else {
        value += character
      }
    }
    if (!closed) {
      warnings.push(`line ${lineNumber}: unterminated double-quoted value`)
      return undefined
    }
    warnTrailing(raw.slice(index), lineNumber, warnings)
    return value
  }

  const comment = raw.search(/\s#/)
  const value = (comment === -1 ? raw : raw.slice(0, comment)).trim()
  return value
}

function warnTrailing(rest: string, lineNumber: number, warnings: string[]) {
  const trimmed = rest.trim()
  if (trimmed && !trimmed.startsWith("#")) {
    warnings.push(`line ${lineNumber}: unexpected text after quoted value`)
  }
}

export function expandValue(
  value: string,
  env: Record<string, string | undefined>,
  options: { bracedOnly?: boolean } = {},
): string {
  if (!value.includes("$")) return value
  const pattern = options.bracedOnly
    ? /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
    : /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
  return value.replace(pattern, (_match, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare
    if (!key) return ""
    const current = env[key]
    if (current === undefined || (fallback !== undefined && current === "")) return fallback ?? ""
    return current
  })
}
