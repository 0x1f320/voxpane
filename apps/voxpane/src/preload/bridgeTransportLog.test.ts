import { describe, expect, it } from "vitest"
import type { BridgeTransportDiagnostics } from "../shared/bridgeDiagnostics"
import { describeTransportChange } from "./bridgeTransportLog"

function transport(patch: Partial<BridgeTransportDiagnostics> = {}): BridgeTransportDiagnostics {
  return {
    status: "ready",
    session: "abc",
    recoveries: 0,
    malformedFrames: 0,
    endpointFailures: 0,
    disconnects: { state: 0, scroll: 0, notes: 0 },
    ...patch,
  }
}

describe("describeTransportChange", () => {
  it("reports the first status", () => {
    expect(describeTransportChange(null, transport({ status: "starting", session: null }))).toEqual(
      [{ level: "debug", message: "transport none -> starting (session none)" }],
    )
  })

  it("is silent when nothing changed", () => {
    expect(describeTransportChange(transport(), transport())).toEqual([])
  })

  it("reports a new session even when the status is the same", () => {
    expect(describeTransportChange(transport(), transport({ session: "def" }))).toEqual([
      { level: "info", message: "transport ready -> ready (session def)" },
    ])
  })

  it("warns on errors, malformed frames and endpoint failures", () => {
    const entries = describeTransportChange(
      transport({ status: "connected", malformedFrames: 1, endpointFailures: 2 }),
      transport({ status: "error", malformedFrames: 3, endpointFailures: 3, recoveries: 1 }),
    )
    expect(entries).toEqual([
      { level: "warn", message: "transport connected -> error (session abc)" },
      { level: "warn", message: "malformed frames +2 (total 3)" },
      { level: "warn", message: "endpoint failures +1 (total 3)" },
      { level: "info", message: "recoveries +1 (total 1)" },
    ])
  })

  it("reports per-channel disconnects", () => {
    expect(
      describeTransportChange(
        transport(),
        transport({ disconnects: { state: 0, scroll: 2, notes: 0 } }),
      ),
    ).toEqual([{ level: "info", message: "scroll disconnects +2 (total 2)" }])
  })
})
