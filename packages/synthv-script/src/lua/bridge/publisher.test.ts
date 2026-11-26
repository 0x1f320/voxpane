import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PipeChannel, PipeConnection } from "./pipe"

const pipe = vi.hoisted(() => ({
  connection: undefined as PipeConnection | undefined,
  directory: "/bridge" as string | undefined,
  disconnects: 0,
  connectElapsed: [] as number[],
  validations: [] as Array<[number, number]>,
  validationResult: true,
  invalidations: [] as string[],
  events: [] as string[],
  writes: [] as Array<[PipeChannel, string]>,
  writeResults: [] as boolean[],
}))

vi.mock("../json", () => ({
  encodeJson: (value: unknown) => JSON.stringify(value),
}))

vi.mock("./paths", () => ({
  bridgeDirectory: () => pipe.directory,
}))

vi.mock("./pipe", () => ({
  createPipeClient: () => ({
    connect: (elapsedMs: number) => {
      pipe.connectElapsed.push(elapsedMs)
      return pipe.connection
    },
    validate: (elapsedMs: number, serial: number) => {
      pipe.validations.push([elapsedMs, serial])
      pipe.events.push("validate")
      return pipe.validationResult
    },
    write: (channel: PipeChannel, frame: string) => {
      pipe.events.push(`write:${channel}`)
      pipe.writes.push([channel, frame])
      const result = pipe.writeResults.shift() ?? true
      if (!result) {
        pipe.connection = undefined
      }
      return result
    },
    invalidate: (message: string) => {
      pipe.invalidations.push(message)
      pipe.connection = undefined
    },
    disconnect: () => {
      pipe.disconnects += 1
      pipe.connection = undefined
    },
    describe: () =>
      pipe.connection === undefined
        ? "disconnected, last error: none"
        : `connected (app ${pipe.connection.session}), last error: none`,
  }),
}))

vi.mock("./codec", () => ({
  LAYOUT: 5,
  encodeSession: (json: string) => `session:${json}`,
  encodeNotes: (notesSeq: number, rev: string) => {
    pipe.events.push("encode-notes")
    return `notes:${notesSeq}:${rev}`
  },
  encodeScroll: (value: { scrollSeq: number }) => `scroll:${value.scrollSeq}`,
  encodeState: (value: { seq: number; notesSeq: number; scrollSeq: number }) =>
    `state:${value.seq}:notes=${value.notesSeq}:scroll=${value.scrollSeq}`,
}))

import { createPublisher } from "./publisher"

const APP_A = "0123456789abcdef0123456789abcdef"
const APP_B = "fedcba9876543210fedcba9876543210"

const defaultState = {
  at: 0,
  status: "playing",
  loop: null,
  perBlick: 1,
  perSemitone: 2,
  viewLeft: 0,
  viewRight: 10,
  viewTop: 80,
  viewBottom: 40,
  rev: "rev-1",
}

const stoppedState = { ...defaultState, status: "stopped" }

function stateWrites(): string[] {
  return pipe.writes
    .filter(([channel, frame]) => channel === "state" && frame.startsWith("state:"))
    .map(([, frame]) => frame)
}

function sessionPayload(index: number): Record<string, unknown> {
  const frame = pipe.writes[index][1]
  expect(frame.startsWith("session:")).toBe(true)
  return JSON.parse(frame.slice("session:".length))
}

beforeEach(() => {
  pipe.connection = { session: APP_A, serial: 1 }
  pipe.directory = "/bridge"
  pipe.disconnects = 0
  pipe.connectElapsed = []
  pipe.validations = []
  pipe.validationResult = true
  pipe.invalidations = []
  pipe.events = []
  pipe.writes = []
  pipe.writeResults = []
  Object.assign(globalThis, {
    os: { time: () => 123 },
    SV: {
      getHostInfo: () => ({
        osType: "macOS",
        hostName: "Synthesizer V Studio 2",
        hostVersion: "2.3.0",
        hostVersionNumber: 131330,
      }),
    },
  })
})

describe("createPublisher", () => {
  it("publishes one layout-5 session frame before reporting a new connection", () => {
    const publisher = createPublisher()

    expect(publisher.prepare(0)).toBe("new-session")
    expect(pipe.writes).toHaveLength(1)
    expect(pipe.writes[0][0]).toBe("state")
    expect(sessionPayload(0)).toMatchObject({
      v: 1,
      layout: 5,
      appSession: APP_A,
      scriptSession: "123:1",
    })
    expect(publisher.prepare(4)).toBe("connected")
    expect(pipe.writes).toHaveLength(1)
  })

  it("uses connection serials to reset and republish even when appSession repeats", () => {
    const publisher = createPublisher()
    expect(publisher.prepare(0)).toBe("new-session")
    publisher.publishNotes("rev-1", [])
    publisher.publishState(defaultState)

    pipe.connection = { session: APP_A, serial: 2 }
    expect(publisher.prepare(240)).toBe("new-session")

    expect(sessionPayload(pipe.writes.length - 1)).toMatchObject({
      appSession: APP_A,
      scriptSession: "123:2",
    })
    expect(publisher.describe()).toContain("seq 0, scroll 0, notes 0")
  })

  it("creates a new script session when a different app session connects", () => {
    const publisher = createPublisher()
    expect(publisher.prepare(0)).toBe("new-session")

    pipe.connection = { session: APP_B, serial: 2 }
    expect(publisher.prepare(240)).toBe("new-session")

    expect(sessionPayload(1)).toMatchObject({ appSession: APP_B, scriptSession: "123:2" })
  })

  it("returns disconnected and tears down when the session frame write fails", () => {
    pipe.writeResults = [false]
    const publisher = createPublisher()

    expect(publisher.prepare(0)).toBe("disconnected")
    expect(pipe.invalidations).toEqual(["session write failed"])
    expect(publisher.describe()).toContain("session write failed")
  })

  it("publishes a complete reconnect snapshot in session, notes, scroll, state order", () => {
    const publisher = createPublisher()

    expect(publisher.prepare(0)).toBe("new-session")
    publisher.publishNotes("r1", [])
    publisher.publishState(defaultState)

    expect(
      pipe.writes.map(([channel, frame]) => [
        channel,
        frame.startsWith("session:") ? "session" : frame,
      ]),
    ).toEqual([
      ["state", "session"],
      ["notes", "notes:1:r1"],
      ["scroll", "scroll:1"],
      ["state", "state:1:notes=1:scroll=1"],
    ])
  })

  it("revalidates the current handle identity after encoding and before a notes write", () => {
    const publisher = createPublisher()
    publisher.prepare(240)
    pipe.events = []

    expect(publisher.publishNotes("r1", [])).toBe(true)

    expect(pipe.validations).toEqual([[240, 1]])
    expect(pipe.events).toEqual(["encode-notes", "validate", "write:notes"])
  })

  it("tears down without writing notes when pre-write validation loses the connection", () => {
    const publisher = createPublisher()
    publisher.prepare(0)
    pipe.validationResult = false
    pipe.writes = []

    expect(publisher.publishNotes("r1", [])).toBe(false)

    expect(pipe.writes).toEqual([])
    expect(pipe.invalidations).toEqual(["notes validation failed"])
    expect(publisher.describe()).toContain("notes validation failed")
  })

  it("does not advertise or publish state after a failed notes write", () => {
    const publisher = createPublisher()
    publisher.prepare(0)
    pipe.writeResults = [false]

    publisher.publishNotes("rev-failed", [])
    publisher.publishState(defaultState)

    expect(pipe.writes.slice(1)).toEqual([["notes", "notes:1:rev-failed"]])
    expect(publisher.describe()).toContain("notes 0")
    expect(publisher.describe()).toContain("notes write failed")
  })

  it("does not proceed to state after a failed scroll write", () => {
    const publisher = createPublisher()
    publisher.prepare(0)
    pipe.writeResults = [false]

    publisher.publishState(defaultState)

    expect(pipe.writes.slice(1)).toEqual([["scroll", "scroll:1"]])
    expect(publisher.describe()).toContain("seq 0, scroll 0")
    expect(publisher.describe()).toContain("scroll write failed")
  })

  it("advances notes and scroll generations only after successful writes", () => {
    const publisher = createPublisher()
    publisher.prepare(0)

    publisher.publishNotes("rev-1", [])
    publisher.publishState(defaultState)
    publisher.publishState(defaultState)

    expect(pipe.writes.slice(1)).toEqual([
      ["notes", "notes:1:rev-1"],
      ["scroll", "scroll:1"],
      ["state", "state:1:notes=1:scroll=1"],
      ["state", "state:2:notes=1:scroll=1"],
    ])
  })

  it("reports unavailable without a bridge directory", () => {
    pipe.directory = undefined
    const publisher = createPublisher()

    expect(publisher.prepare(0)).toBe("disconnected")
    expect(publisher.describe()).toContain("no home directory")
    expect(pipe.writes).toEqual([])
  })

  it("closes the shared handle set through the pipe client", () => {
    const publisher = createPublisher()
    publisher.prepare(0)

    publisher.close()

    expect(pipe.disconnects).toBe(1)
  })

  it("aborts an incomplete reconnect snapshot and requires fresh preparation", () => {
    const publisher = createPublisher()
    publisher.prepare(0)

    publisher.abortSnapshot("notes collection failed")

    expect(pipe.invalidations).toEqual(["notes collection failed"])
    expect(publisher.describe()).toContain("notes collection failed")
  })
})

describe("state cadence", () => {
  function tick(
    publisher: ReturnType<typeof createPublisher>,
    elapsedMs: number,
    state: typeof defaultState,
  ): void {
    publisher.prepare(elapsedMs)
    publisher.publishState(state)
  }

  it("writes a stopped state once and then stays quiet while nothing changes", () => {
    const publisher = createPublisher()

    for (let elapsedMs = 0; elapsedMs < 48; elapsedMs += 4) {
      tick(publisher, elapsedMs, stoppedState)
    }

    expect(stateWrites()).toEqual(["state:1:notes=0:scroll=1"])
    expect(publisher.describe()).toContain("seq 1, scroll 1")
  })

  it("writes a keepalive every 48 ms of quiet, so the app keeps seeing the script alive", () => {
    const publisher = createPublisher()

    for (let elapsedMs = 0; elapsedMs <= 200; elapsedMs += 4) {
      tick(publisher, elapsedMs, stoppedState)
    }

    expect(stateWrites()).toEqual([
      "state:1:notes=0:scroll=1",
      "state:2:notes=0:scroll=1",
      "state:3:notes=0:scroll=1",
      "state:4:notes=0:scroll=1",
      "state:5:notes=0:scroll=1",
    ])
  })

  it("writes every tick while the transport is not stopped, moving or not", () => {
    const publisher = createPublisher()

    for (const status of ["playing", "looping"]) {
      for (let count = 0; count < 3; count += 1) {
        tick(publisher, 0, { ...defaultState, status })
      }
    }

    expect(stateWrites()).toHaveLength(6)
  })

  it.each([
    ["the playhead moves", { at: 3 }],
    ["playback starts", { status: "playing" }],
    ["loop bounds are learned", { loop: { start: 1, end: 2 } }],
    ["the revision changes", { rev: "rev-2" }],
  ])("writes on the tick %s", (_name, change) => {
    const publisher = createPublisher()
    tick(publisher, 0, stoppedState)
    tick(publisher, 4, stoppedState)

    tick(publisher, 8, { ...stoppedState, ...change })

    expect(stateWrites()).toHaveLength(2)
  })

  it("does not take equal loop bounds in a fresh object for a change", () => {
    const publisher = createPublisher()

    tick(publisher, 0, { ...stoppedState, loop: { start: 1, end: 2 } })
    tick(publisher, 4, { ...stoppedState, loop: { start: 1, end: 2 } })
    tick(publisher, 8, { ...stoppedState, loop: { start: 1, end: 2.5 } })

    expect(stateWrites()).toHaveLength(2)
  })

  it("writes the state that pairs with a scroll frame on the tick the view moves", () => {
    const publisher = createPublisher()
    tick(publisher, 0, stoppedState)
    tick(publisher, 4, stoppedState)
    pipe.writes = []

    tick(publisher, 8, { ...stoppedState, viewLeft: 5, viewRight: 15 })

    expect(pipe.writes).toEqual([
      ["scroll", "scroll:2"],
      ["state", "state:2:notes=0:scroll=2"],
    ])
  })

  it("writes the state that names a new notes generation on the tick it is published", () => {
    const publisher = createPublisher()
    tick(publisher, 0, stoppedState)
    tick(publisher, 4, stoppedState)

    publisher.prepare(8)
    publisher.publishNotes("rev-1", [])
    publisher.publishState(stoppedState)

    expect(stateWrites()).toEqual(["state:1:notes=0:scroll=1", "state:2:notes=1:scroll=1"])
  })

  it("measures the quiet from the last state written, whatever made it due", () => {
    const publisher = createPublisher()
    tick(publisher, 0, stoppedState)
    tick(publisher, 40, { ...stoppedState, at: 3 })

    tick(publisher, 48, { ...stoppedState, at: 3 })
    tick(publisher, 84, { ...stoppedState, at: 3 })
    expect(stateWrites()).toHaveLength(2)

    tick(publisher, 88, { ...stoppedState, at: 3 })
    expect(stateWrites()).toHaveLength(3)
  })

  it("writes the first state of a new connection even when nothing changed", () => {
    const publisher = createPublisher()
    tick(publisher, 0, stoppedState)
    tick(publisher, 4, stoppedState)

    pipe.connection = { session: APP_A, serial: 2 }
    tick(publisher, 8, stoppedState)

    expect(stateWrites()).toEqual(["state:1:notes=0:scroll=1", "state:1:notes=0:scroll=1"])
  })

  it("tries again on the next tick after a state write fails and the pipe comes back", () => {
    const publisher = createPublisher()
    tick(publisher, 0, stoppedState)
    pipe.writeResults = [false]

    tick(publisher, 48, stoppedState)
    expect(publisher.describe()).toContain("state write failed")

    pipe.connection = { session: APP_A, serial: 2 }
    tick(publisher, 52, stoppedState)

    expect(stateWrites().at(-1)).toBe("state:1:notes=0:scroll=1")
    expect(publisher.describe()).toContain("seq 1, scroll 1")
  })
})
