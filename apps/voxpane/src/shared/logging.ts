export const LOG_LEVELS = ["error", "warn", "info", "verbose", "debug", "silly"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const RENDERER_LOG_LEVELS = ["error", "warn", "info", "debug"] as const
export type RendererLogLevel = (typeof RENDERER_LOG_LEVELS)[number]

export const LOG_WRITE_CHANNEL = "log:write"
export const LOG_OPEN_FOLDER_CHANNEL = "log:openFolder"

export const LOG_FILE_NAME = "main.log"
export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_ARCHIVES_KEPT = 3

const MAX_RENDERER_DATA_ITEMS = 8
const MAX_RENDERER_STRING_LENGTH = 4000
const SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,23}$/

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}

export function resolveLogLevel(override: string | undefined, packaged: boolean): LogLevel {
  const requested = override?.trim().toLowerCase()
  if (requested && isLogLevel(requested)) {
    return requested
  }
  return packaged ? "info" : "debug"
}

export interface RendererLogEntry {
  level: RendererLogLevel
  scope: string
  data: unknown[]
}

function clampString(value: string): string {
  return value.length > MAX_RENDERER_STRING_LENGTH
    ? `${value.slice(0, MAX_RENDERER_STRING_LENGTH)}…`
    : value
}

export function parseRendererLogEntry(
  level: unknown,
  scope: unknown,
  data: unknown,
): RendererLogEntry | null {
  if (typeof level !== "string" || !(RENDERER_LOG_LEVELS as readonly string[]).includes(level)) {
    return null
  }
  if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
    return null
  }
  if (!Array.isArray(data)) {
    return null
  }
  return {
    level: level as RendererLogLevel,
    scope,
    data: data
      .slice(0, MAX_RENDERER_DATA_ITEMS)
      .map((item) => (typeof item === "string" ? clampString(item) : item)),
  }
}

export interface LogRename {
  from: string
  to: string
}

/**
 * Oldest first, so no rename lands on a file that has not been moved out of
 * the way yet.
 */
export function planLogRotation(file: string, keep: number): LogRename[] {
  if (keep < 1) {
    return []
  }
  const dot = file.lastIndexOf(".")
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  const hasExtension = dot > slash + 1
  const stem = hasExtension ? file.slice(0, dot) : file
  const extension = hasExtension ? file.slice(dot) : ""
  const archive = (index: number) => `${stem}.${index}${extension}`
  const renames: LogRename[] = []
  for (let index = keep - 1; index >= 1; index -= 1) {
    renames.push({ from: archive(index), to: archive(index + 1) })
  }
  renames.push({ from: file, to: archive(1) })
  return renames
}
