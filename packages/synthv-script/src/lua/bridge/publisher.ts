import { encodeJson } from "../json"
import { SCRIPT_VERSION } from "../version"
import {
  encodeNotes,
  encodeScroll,
  encodeSession,
  encodeState,
  LAYOUT,
  type NoteRecord,
  type StateRecord,
} from "./codec"
import { bridgeDirectory } from "./paths"
import { createPipeClient } from "./pipe"

const PROTOCOL = 1

/**
 * The longest the state channel stays quiet while the transport is stopped and
 * nothing it reports has changed, in nominal milliseconds.
 *
 * The app reads a state `seq` that has stood still for 500 ms (`SILENCE_MS` in
 * the renderer's transport.ts) as the script being gone, and drops its view of
 * the roll, which also cuts off effects still finishing after a stop. Nominal
 * matters: elapsed time here is a tick count, the host has no sub-second wall
 * clock to check it against, and a busy editor runs its ticks late. A tenth of
 * the app's limit keeps the script alive in the app's eyes even with ticks
 * running ten times slower than asked for.
 */
const STATE_KEEPALIVE_MS = 48

export interface StateValue {
  at: number
  status: string
  loop: { start: number; end: number } | null
  perBlick: number
  perSemitone: number
  viewLeft: number
  viewRight: number
  viewTop: number
  viewBottom: number
  rev: string
}

interface ScrollValue {
  perBlick: number
  perSemitone: number
  viewLeft: number
  viewRight: number
  viewTop: number
  viewBottom: number
}

export type PrepareResult = "new-session" | "connected" | "disconnected"

export interface Publisher {
  prepare(elapsedMs: number): PrepareResult
  publishState(state: StateValue): void
  publishNotes(rev: string, notes: NoteRecord[]): boolean
  abortSnapshot(message: string): void
  describe(): string
  close(): void
}

export function createPublisher(): Publisher {
  const directory = bridgeDirectory()
  if (directory === undefined) {
    return unavailable("no home directory")
  }

  const client = createPipeClient(directory)
  const scriptStartedAt = os.time()
  const host = SV.getHostInfo()
  let connectionCounter = 0
  let activeConnectionSerial: number | undefined
  let appSession = "none"
  let scriptSession = "none"
  let seq = 0
  let notesSeq = 0
  let scrollSeq = 0
  let lastScroll: ScrollValue | null = null
  let lastState: StateRecord | null = null
  let lastStateElapsedMs = 0
  let lastError = "none"
  let lastElapsedMs = 0

  function resetPublicationState(): void {
    seq = 0
    notesSeq = 0
    scrollSeq = 0
    lastScroll = null
    lastState = null
  }

  function deactivate(message: string): void {
    activeConnectionSerial = undefined
    lastError = message
  }

  return {
    prepare(elapsedMs) {
      lastElapsedMs = elapsedMs
      const connection = client.connect(elapsedMs)
      if (connection === undefined) {
        activeConnectionSerial = undefined
        return "disconnected"
      }
      if (connection.serial === activeConnectionSerial) {
        return "connected"
      }

      resetPublicationState()
      connectionCounter = connectionCounter + 1
      appSession = connection.session
      scriptSession = `${scriptStartedAt}:${connectionCounter}`
      const sessionFrame = encodeSession(
        encodeJson({
          v: PROTOCOL,
          layout: LAYOUT,
          appSession,
          scriptSession,
          scriptVersion: SCRIPT_VERSION,
          host: {
            osType: host.osType,
            hostName: host.hostName,
            hostVersion: host.hostVersion,
            hostVersionNumber: host.hostVersionNumber,
          },
        }),
      )
      if (!client.write("state", sessionFrame)) {
        deactivate("session write failed")
        client.invalidate("session write failed")
        return "disconnected"
      }

      activeConnectionSerial = connection.serial
      lastError = "none"
      return "new-session"
    },

    publishState(value) {
      if (activeConnectionSerial === undefined) {
        return
      }

      const nextScroll = scrollValue(value)
      if (lastScroll === null || !sameScroll(lastScroll, nextScroll)) {
        const nextScrollSeq = scrollSeq + 1
        if (!client.write("scroll", encodeScroll({ scrollSeq: nextScrollSeq, ...nextScroll }))) {
          deactivate("scroll write failed")
          return
        }
        scrollSeq = nextScrollSeq
        lastScroll = nextScroll
      }

      const record: StateRecord = {
        seq: seq + 1,
        notesSeq,
        scrollSeq,
        at: value.at,
        status: value.status,
        loop: value.loop,
        rev: value.rev,
      }
      // A stopped transport that reports nothing new is not worth a pack and a
      // synchronous write on the editor's UI thread 250 times a second, nor a
      // wake-up of the app for each one. Playback is never thinned: the app pins
      // its playhead to the newest record at the moment it reads it, so the
      // record has to be at most a tick old, and a playhead standing still
      // under a playing status must keep being re-pinned where it stands.
      if (
        lastState !== null &&
        record.status === "stopped" &&
        sameReport(lastState, record) &&
        lastElapsedMs - lastStateElapsedMs < STATE_KEEPALIVE_MS
      ) {
        return
      }
      if (!client.write("state", encodeState(record))) {
        deactivate("state write failed")
        return
      }
      seq = record.seq
      lastState = record
      lastStateElapsedMs = lastElapsedMs
    },

    publishNotes(rev, notes) {
      if (activeConnectionSerial === undefined) {
        return false
      }
      const nextNotesSeq = notesSeq + 1
      const notesFrame = encodeNotes(nextNotesSeq, rev, notes)
      if (!client.validate(lastElapsedMs, activeConnectionSerial)) {
        deactivate("notes validation failed")
        client.invalidate("notes validation failed")
        return false
      }
      if (!client.write("notes", notesFrame)) {
        deactivate("notes write failed")
        return false
      }
      notesSeq = nextNotesSeq
      return true
    },

    abortSnapshot(message) {
      deactivate(message)
      client.invalidate(message)
    },

    describe() {
      return `${directory} (${client.describe()}, app ${appSession}, script ${scriptSession}, seq ${seq}, scroll ${scrollSeq}, notes ${notesSeq}, last error: ${lastError})`
    },

    close() {
      activeConnectionSerial = undefined
      client.disconnect()
    },
  }
}

function scrollValue(value: StateValue): ScrollValue {
  return {
    perBlick: value.perBlick,
    perSemitone: value.perSemitone,
    viewLeft: value.viewLeft,
    viewRight: value.viewRight,
    viewTop: value.viewTop,
    viewBottom: value.viewBottom,
  }
}

function sameScroll(left: ScrollValue, right: ScrollValue): boolean {
  return (
    left.perBlick === right.perBlick &&
    left.perSemitone === right.perSemitone &&
    left.viewLeft === right.viewLeft &&
    left.viewRight === right.viewRight &&
    left.viewTop === right.viewTop &&
    left.viewBottom === right.viewBottom
  )
}

/** Everything a state record says apart from its own sequence number. */
function sameReport(left: StateRecord, right: StateRecord): boolean {
  return (
    left.at === right.at &&
    left.status === right.status &&
    left.rev === right.rev &&
    left.notesSeq === right.notesSeq &&
    left.scrollSeq === right.scrollSeq &&
    sameLoop(left.loop, right.loop)
  )
}

function sameLoop(left: StateRecord["loop"], right: StateRecord["loop"]): boolean {
  if (left === null || right === null) {
    return left === right
  }
  return left.start === right.start && left.end === right.end
}

function unavailable(reason: string): Publisher {
  return {
    prepare: () => "disconnected",
    publishState: () => {},
    publishNotes: () => false,
    abortSnapshot: () => {},
    describe: () => `disconnected, last error: ${reason}`,
    close: () => {},
  }
}
