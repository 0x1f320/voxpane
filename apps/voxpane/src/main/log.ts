import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { app, type BrowserWindow, ipcMain, shell } from "electron"
import log from "electron-log/main"
import {
  LOG_ARCHIVES_KEPT,
  LOG_FILE_NAME,
  LOG_MAX_BYTES,
  LOG_OPEN_FOLDER_CHANNEL,
  LOG_WRITE_CHANNEL,
  parseRendererLogEntry,
  planLogRotation,
  resolveLogLevel,
} from "../shared/logging"
import { redactValue } from "../shared/logRedact"

export function logger(scope: string): ReturnType<typeof log.scope> {
  return log.scope(scope)
}

export function logDirectory(): string {
  return path.join(app.getPath("userData"), "logs")
}

// electron-log's own File has crop(), but its typings leave it out.
function archiveLog(file: { toString(): string; crop?(bytes: number): void }): void {
  try {
    for (const { from, to } of planLogRotation(file.toString(), LOG_ARCHIVES_KEPT)) {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to)
      }
    }
  } catch {
    file.crop?.(Math.round(LOG_MAX_BYTES / 4))
  }
}

// Must run after userData is pinned: the file transport resolves its path lazily,
// but anything logged before the pin would land under the default userData.
export function initLogging(): void {
  const level = resolveLogLevel(process.env.VOXPANE_LOG_LEVEL, app.isPackaged)
  const redact = { home: homedir() }

  log.transports.file.resolvePathFn = () => path.join(logDirectory(), LOG_FILE_NAME)
  log.transports.file.maxSize = LOG_MAX_BYTES
  log.transports.file.archiveLogFn = archiveLog
  log.transports.file.level = level
  log.transports.console.level = level
  log.hooks.push((message) => ({
    ...message,
    data: message.data.map((item) => redactValue(item, redact)),
  }))

  // A monitor observes without replacing Electron's own uncaught-exception
  // handling; crash reporting is a separate concern (#40).
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    log.scope("process").error(`uncaught (${origin}):`, error)
  })
  log.eventLogger.startLogging({
    scope: "event",
    events: {
      app: { "certificate-error": true, "child-process-gone": true, "render-process-gone": false },
      webContents: {
        "did-fail-load": true,
        "did-fail-provisional-load": true,
        "plugin-crashed": true,
        "preload-error": true,
        unresponsive: false,
      },
    },
  })

  log.scope("app").info(`starting ${app.getVersion()}`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    level,
  })
}

export async function openLogFolder(): Promise<void> {
  const directory = logDirectory()
  try {
    fs.mkdirSync(directory, { recursive: true })
    const failure = await shell.openPath(directory)
    if (failure) {
      log.scope("app").warn("failed to open the log folder:", failure)
    }
  } catch (error) {
    log.scope("app").warn("failed to open the log folder:", error)
  }
}

export function registerLogIpc(): void {
  const rendererLog = log.scope("renderer")
  ipcMain.on(LOG_WRITE_CHANNEL, (_event, level: unknown, scope: unknown, data: unknown) => {
    const entry = parseRendererLogEntry(level, scope, data)
    if (entry) {
      rendererLog[entry.level](`[${entry.scope}]`, ...entry.data)
    }
  })
  ipcMain.handle(LOG_OPEN_FOLDER_CHANNEL, () => openLogFolder())
}

export function watchWindowLifecycle(win: BrowserWindow, name: string): void {
  const windowLog = log.scope("window")
  windowLog.debug(`${name}: created`)
  win.on("show", () => windowLog.debug(`${name}: shown`))
  win.on("hide", () => windowLog.debug(`${name}: hidden`))
  win.on("closed", () => windowLog.debug(`${name}: closed`))
  win.on("unresponsive", () => windowLog.warn(`${name}: unresponsive`))
  win.on("responsive", () => windowLog.info(`${name}: responsive again`))
  win.webContents.on("render-process-gone", (_event, details) => {
    windowLog.error(`${name}: renderer gone`, details)
  })
}
