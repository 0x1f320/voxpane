import type { BridgeSchedule, BridgeState } from "../../shared/bridgeChannels"
import type { BridgeDiagnostics } from "../../shared/bridgeDiagnostics"
import type { CanvasSnapshot } from "../../shared/geometry"
import type { PermissionKey, PermissionsStatus } from "../../shared/permissions"
import type { Preferences, PreferencesPatch } from "../../shared/preferences"

declare global {
  interface Window {
    overlay: {
      getCanvasAsync(): Promise<CanvasSnapshot | null>
      /** Whether main is showing the overlay window. False until main says otherwise. */
      isShown(): boolean
      onShownChange(callback: (shown: boolean) => void): () => void
    }
    bridge: {
      /** The hot channel: playhead, transport and view transform. Safe per-frame. */
      readState(): BridgeState | null
      /** The note schedule. Only worth reading when readState's notesSeq changes. */
      readSchedule(notesSeq: number): BridgeSchedule | null
      readDiagnostics(): BridgeDiagnostics
      /**
       * Arm a one-shot: `listener` runs when a state that is not stopped next
       * arrives. For a frame loop that stopped while nothing was playing; never
       * fires for the state `readState` already returns.
       */
      wakeOnPlayback(listener: () => void): void
      setDiagnosticsEnabled(enabled: boolean): void
      /** Monotonic clock shared with native geometry reads, for measuring age. */
      monotonicNow(): number
    }
    settings: {
      /** Open the settings window, or focus it if it is already open. */
      open(): Promise<void>
      /** Close the settings window. */
      close(): Promise<void>
      /** Whether the settings window hides the system caption and expects its own. */
      customTitleBar: boolean
    }
    panel: {
      /**
       * Fit the toolbar window to this content height. The window stays hidden
       * until the first call, so the placeholder size is never shown.
       */
      resize(height: number): Promise<void>
    }
    app: {
      /** Quit the whole app — the toolbar, the overlay and the tray go with it. */
      quit(): Promise<void>
    }
    logger: {
      /** Append to the app log, under `scope`. Not for the per-frame path: each call is an IPC send. */
      error(scope: string, ...data: unknown[]): void
      warn(scope: string, ...data: unknown[]): void
      info(scope: string, ...data: unknown[]): void
      /** Reveal the log folder in the file manager. */
      openFolder(): Promise<void>
    }
    debug: {
      /** Report a debug-only latency summary outside the renderer console. */
      latency(line: string): void
    }
    permissions: {
      /** Current grant status. */
      get(): Promise<PermissionsStatus>
      /** Open the System Settings pane this permission is granted from. */
      openSettings(key: PermissionKey): Promise<void>
      /** Leave the gate and start the app. Ignored while still untrusted. */
      proceed(): Promise<void>
      /** Fit the window to this content height, within the gate's own limits. */
      resize(height: number): Promise<void>
      /** Subscribe to grant changes. Returns an unsubscribe function. */
      onChange(callback: (status: PermissionsStatus) => void): () => void
    }
    assets: {
      /**
       * Ask for an image, and keep a copy of the chosen one. Resolves to its
       * stored name, or null if the dialog was dismissed.
       */
      import(): Promise<string | null>
    }
    i18n: {
      /**
       * The OS's preferred languages, most wanted first. Chromium's own
       * navigator.languages does not follow them, so main is asked instead.
       */
      systemLanguages(): Promise<string[]>
    }
    preferences: {
      /** Current persisted preferences. */
      get(): Promise<Preferences>
      /** Merge a patch into the stored preferences and broadcast the result. */
      update(patch: PreferencesPatch): Promise<Preferences>
      /** Subscribe to updates from any window. Returns an unsubscribe function. */
      onChange(callback: (prefs: Preferences) => void): () => void
    }
  }
}
