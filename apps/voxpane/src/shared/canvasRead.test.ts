import { describe, expect, it, vi } from "vitest"
import { reportCanvasReadChanges } from "./canvasRead"

describe("reportCanvasReadChanges", () => {
  const snapshot = { canvas: { x: 1, y: 2, w: 3, h: 4 } }

  it("reports each change of outcome once", async () => {
    const results: (typeof snapshot | null | Error)[] = [
      null,
      null,
      snapshot,
      snapshot,
      new Error("ax"),
      new Error("ax"),
      snapshot,
    ]
    const report = vi.fn()
    const read = reportCanvasReadChanges(async () => {
      const next = results.shift()
      if (next instanceof Error) {
        throw next
      }
      return next ?? null
    }, report)

    for (let i = 0; i < 7; i += 1) {
      await read().catch(() => {})
    }

    expect(report.mock.calls.map(([outcome]) => outcome)).toEqual([
      "missing",
      "found",
      "failed",
      "found",
    ])
    expect(report.mock.calls[2]?.[1]).toBeInstanceOf(Error)
  })

  it("passes the read through, including its rejection", async () => {
    const failure = new Error("ax")
    const read = reportCanvasReadChanges(async () => {
      throw failure
    }, vi.fn())

    await expect(read()).rejects.toBe(failure)
  })
})
