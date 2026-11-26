import { describe, expect, it } from "vitest"
import { OVERLAY_SHOWN_CHANNEL } from "../shared/overlayShownIpc"
import { OverlayVisibility } from "./overlayVisibility"

function overlayWindow(options: { visible?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = []
  const sent: Array<[string, boolean]> = []
  const win = {
    visible: options.visible ?? false,
    isDestroyed: () => options.destroyed ?? false,
    isVisible: () => win.visible,
    showInactive: () => {
      calls.push("show")
      win.visible = true
    },
    hide: () => {
      calls.push("hide")
      win.visible = false
    },
    webContents: {
      send: (channel: string, shown: boolean) => {
        sent.push([channel, shown])
      },
    },
  }
  return { win, calls, sent }
}

describe("OverlayVisibility", () => {
  it("starts hidden", () => {
    expect(new OverlayVisibility().shown).toBe(false)
  })

  it("shows the window and tells its renderer", () => {
    const visibility = new OverlayVisibility()
    const { win, calls, sent } = overlayWindow()

    visibility.apply(win, true)

    expect(calls).toEqual(["show"])
    expect(sent).toEqual([[OVERLAY_SHOWN_CHANNEL, true]])
    expect(visibility.shown).toBe(true)
  })

  it("hides the window and tells its renderer", () => {
    const visibility = new OverlayVisibility()
    const { win, calls, sent } = overlayWindow()
    visibility.apply(win, true)

    visibility.apply(win, false)

    expect(calls).toEqual(["show", "hide"])
    expect(sent).toEqual([
      [OVERLAY_SHOWN_CHANNEL, true],
      [OVERLAY_SHOWN_CHANNEL, false],
    ])
    expect(visibility.shown).toBe(false)
  })

  it("says nothing when a repeated frame report changes nothing", () => {
    const visibility = new OverlayVisibility()
    const { win, calls, sent } = overlayWindow()

    visibility.apply(win, true)
    visibility.apply(win, true)
    visibility.apply(win, true)

    expect(calls).toEqual(["show"])
    expect(sent).toHaveLength(1)
  })

  it("tells the renderer about a hide and a restore the system already performed", () => {
    const visibility = new OverlayVisibility()
    const { win, calls, sent } = overlayWindow()
    visibility.apply(win, true)

    win.visible = false
    visibility.apply(win, false)
    win.visible = true
    visibility.apply(win, true)

    expect(calls).toEqual(["show"])
    expect(sent).toEqual([
      [OVERLAY_SHOWN_CHANNEL, true],
      [OVERLAY_SHOWN_CHANNEL, false],
      [OVERLAY_SHOWN_CHANNEL, true],
    ])
  })

  it("puts a window back that left the screen while it was meant to be shown", () => {
    const visibility = new OverlayVisibility()
    const { win, calls, sent } = overlayWindow()
    visibility.apply(win, true)

    win.visible = false
    visibility.apply(win, true)

    expect(calls).toEqual(["show", "show"])
    expect(sent).toHaveLength(1)
  })

  it("leaves a destroyed window alone", () => {
    const visibility = new OverlayVisibility()
    const { win, calls, sent } = overlayWindow({ destroyed: true })

    visibility.apply(win, true)

    expect(calls).toEqual([])
    expect(sent).toEqual([])
    expect(visibility.shown).toBe(false)
  })
})
