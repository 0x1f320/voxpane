export interface RedactContext {
  home: string
}

const MAX_DEPTH = 4

const USER_DIRECTORY_PATTERNS: readonly [RegExp, string][] = [
  [/\/Users\/[^/\s"'`:]+/g, "/Users/<user>"],
  [/\/home\/[^/\s"'`:]+/g, "/home/<user>"],
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'`:]+/gi, "$1<user>"],
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function homeVariants(home: string): string[] {
  if (!home || home === "/" || home.length < 3) {
    return []
  }
  const trimmed = home.replace(/[\\/]+$/, "")
  const variants = new Set([trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\")])
  return [...variants].sort((a, b) => b.length - a.length)
}

export function redactText(text: string, context: RedactContext): string {
  let result = text
  for (const variant of homeVariants(context.home)) {
    result = result.replace(new RegExp(`${escapeRegExp(variant)}(?=$|[\\\\/\\s"'\`:])`, "gi"), "~")
  }
  for (const [pattern, replacement] of USER_DIRECTORY_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function redactError(error: Error, context: RedactContext, depth: number): Error {
  const copy = new Error(redactText(error.message, context))
  copy.name = error.name
  copy.stack = error.stack === undefined ? undefined : redactText(error.stack, context)
  const code = (error as NodeJS.ErrnoException).code
  if (code !== undefined) {
    ;(copy as NodeJS.ErrnoException).code = code
  }
  if (error.cause !== undefined) {
    copy.cause = redactValue(error.cause, context, depth + 1)
  }
  return copy
}

export function redactValue(value: unknown, context: RedactContext, depth = 0): unknown {
  if (typeof value === "string") {
    return redactText(value, context)
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  if (depth >= MAX_DEPTH) {
    return "[…]"
  }
  if (value instanceof Error) {
    return redactError(value, context, depth)
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, context, depth + 1))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(item, context, depth + 1)]),
  )
}
