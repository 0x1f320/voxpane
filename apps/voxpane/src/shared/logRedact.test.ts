import { describe, expect, it } from "vitest"
import { redactText, redactValue } from "./logRedact"

const mac = { home: "/Users/alice" }
const win = { home: "C:\\Users\\Alice" }

describe("redactText", () => {
  it("replaces the home directory with ~", () => {
    expect(redactText("open /Users/alice/Library/x.json failed", mac)).toBe(
      "open ~/Library/x.json failed",
    )
  })

  it("replaces a Windows home in either slash direction and any case", () => {
    expect(redactText("C:\\Users\\Alice\\Documents\\a.lua", win)).toBe("~\\Documents\\a.lua")
    expect(redactText("c:/users/alice/AppData", win)).toBe("~/AppData")
  })

  it("masks other users' directories", () => {
    expect(redactText("/Users/bob/x and /home/carol/y", mac)).toBe(
      "/Users/<user>/x and /home/<user>/y",
    )
    expect(redactText("D:\\Users\\dave\\x", mac)).toBe("D:\\Users\\<user>\\x")
  })

  it("does not treat a longer sibling name as the home directory", () => {
    expect(redactText("/Users/alicex/a", mac)).toBe("/Users/<user>/a")
  })

  it("leaves unrelated paths alone", () => {
    expect(redactText("/Applications/voxpane.app/Contents", mac)).toBe(
      "/Applications/voxpane.app/Contents",
    )
  })

  it("ignores a degenerate home", () => {
    expect(redactText("/tmp/x", { home: "/" })).toBe("/tmp/x")
    expect(redactText("/tmp/x", { home: "" })).toBe("/tmp/x")
  })
})

describe("redactValue", () => {
  it("redacts strings nested in plain objects and arrays", () => {
    expect(redactValue({ file: "/Users/alice/a", list: ["/Users/alice/b", 3] }, mac)).toEqual({
      file: "~/a",
      list: ["~/b", 3],
    })
  })

  it("copies an error with a redacted message, stack and code", () => {
    const error = Object.assign(new Error("ENOENT: /Users/alice/prefs.json"), { code: "ENOENT" })
    error.stack = "Error: ENOENT: /Users/alice/prefs.json\n    at /Users/alice/app.js:1:1"
    const redacted = redactValue(error, mac) as NodeJS.ErrnoException

    expect(redacted).toBeInstanceOf(Error)
    expect(redacted).not.toBe(error)
    expect(redacted.message).toBe("ENOENT: ~/prefs.json")
    expect(redacted.stack).toBe("Error: ENOENT: ~/prefs.json\n    at ~/app.js:1:1")
    expect(redacted.code).toBe("ENOENT")
    expect(error.message).toBe("ENOENT: /Users/alice/prefs.json")
  })

  it("redacts an error's cause", () => {
    const error = new Error("outer", { cause: new Error("/Users/alice/inner") })
    expect(((redactValue(error, mac) as Error).cause as Error).message).toBe("~/inner")
  })

  it("passes primitives and class instances through", () => {
    const date = new Date(0)
    expect(redactValue(42, mac)).toBe(42)
    expect(redactValue(null, mac)).toBe(null)
    expect(redactValue(date, mac)).toBe(date)
  })

  it("stops at a fixed depth", () => {
    const deep = { a: { b: { c: { d: { e: "/Users/alice" } } } } }
    expect(redactValue(deep, mac)).toEqual({ a: { b: { c: { d: "[…]" } } } })
  })
})
