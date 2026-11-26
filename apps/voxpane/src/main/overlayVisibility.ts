import { OVERLAY_SHOWN_CHANNEL } from "../shared/overlayShownIpc"

// Tells the overlay's renderer whether its window is on screen.
//
// The renderer cannot find out for itself: with backgroundThrottling off, the
// page of a hidden window still reads as visible and its frame loop keeps its
// full rate. Tracked as intent rather than read off the window, because Windows
// hides and restores an owned window with its owner without Electron being
// asked — the renderer has to hear about those too.

interface OverlayWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  showInactive(): void
  hide(): void
  webContents: { send(channel: string, shown: boolean): void }
}

export class OverlayVisibility {
  private current = false

  get shown(): boolean {
    return this.current
  }

  apply(win: OverlayWindow, shown: boolean): void {
    if (win.isDestroyed()) {
      return
    }
    if (shown && !win.isVisible()) {
      win.showInactive()
    } else if (!shown && win.isVisible()) {
      win.hide()
    }
    if (shown === this.current) {
      return
    }
    this.current = shown
    win.webContents.send(OVERLAY_SHOWN_CHANNEL, shown)
  }
}
