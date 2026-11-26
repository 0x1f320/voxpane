import { describe, expect, it } from "vitest"
import { parseRendererLogEntry, planLogRotation, resolveLogLevel } from "./logging"

describe("resolveLogLevel", () => {
  it("defaults to debug in development and info when packaged", () => {
    expect(resolveLogLevel(undefined, false)).toBe("debug")
    expect(resolveLogLevel(undefined, true)).toBe("info")
  })

  it("honours a valid override", () => {
    expect(resolveLogLevel(" Verbose ", true)).toBe("verbose")
  })

  it("ignores an unknown override", () => {
    expect(resolveLogLevel("loud", true)).toBe("info")
  })
})

describe("parseRendererLogEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(parseRendererLogEntry("warn", "bridge", ["a", 1])).toEqual({
      level: "warn",
      scope: "bridge",
      data: ["a", 1],
    })
  })

  it("rejects unknown levels, malformed scopes and non-array data", () => {
    expect(parseRendererLogEntry("silly", "bridge", [])).toBeNull()
    expect(parseRendererLogEntry("info", "Bridge Scope", [])).toBeNull()
    expect(parseRendererLogEntry("info", "bridge", "text")).toBeNull()
  })

  it("bounds how much one entry can carry", () => {
    const entry = parseRendererLogEntry("info", "bridge", [
      "x".repeat(5000),
      ...Array.from({ length: 20 }, (_, i) => i),
    ])
    expect(entry?.data).toHaveLength(8)
    expect(String(entry?.data[0])).toHaveLength(4001)
  })
})

describe("planLogRotation", () => {
  it("shifts the archives oldest first, then moves the live file", () => {
    expect(planLogRotation("/logs/main.log", 3)).toEqual([
      { from: "/logs/main.2.log", to: "/logs/main.3.log" },
      { from: "/logs/main.1.log", to: "/logs/main.2.log" },
      { from: "/logs/main.log", to: "/logs/main.1.log" },
    ])
  })

  it("handles a file without an extension and a dotted directory", () => {
    expect(planLogRotation("C:\\a.b\\main", 1)).toEqual([
      { from: "C:\\a.b\\main", to: "C:\\a.b\\main.1" },
    ])
  })

  it("plans nothing when nothing is kept", () => {
    expect(planLogRotation("/logs/main.log", 0)).toEqual([])
  })
})
