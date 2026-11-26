import type { BridgeTransportDiagnostics } from "../shared/bridgeDiagnostics"

export interface TransportLogEntry {
  level: "error" | "warn" | "info" | "debug"
  message: string
}

const STATUS_LEVEL: Record<BridgeTransportDiagnostics["status"], TransportLogEntry["level"]> = {
  starting: "debug",
  ready: "info",
  connected: "info",
  error: "warn",
  stopped: "info",
}

/**
 * Transport messages are published on lifecycle changes, never per frame, so
 * each difference is worth one line.
 */
export function describeTransportChange(
  previous: BridgeTransportDiagnostics | null,
  next: BridgeTransportDiagnostics,
): TransportLogEntry[] {
  const entries: TransportLogEntry[] = []
  if (previous?.status !== next.status || previous?.session !== next.session) {
    entries.push({
      level: STATUS_LEVEL[next.status] ?? "info",
      message: `transport ${previous?.status ?? "none"} -> ${next.status} (session ${next.session ?? "none"})`,
    })
  }
  const counters: [string, number, number | undefined, TransportLogEntry["level"]][] = [
    ["malformed frames", next.malformedFrames, previous?.malformedFrames, "warn"],
    ["endpoint failures", next.endpointFailures, previous?.endpointFailures, "warn"],
    ["recoveries", next.recoveries, previous?.recoveries, "info"],
    ...(["state", "scroll", "notes"] as const).map(
      (channel): [string, number, number | undefined, TransportLogEntry["level"]] => [
        `${channel} disconnects`,
        next.disconnects[channel],
        previous?.disconnects[channel],
        "info",
      ],
    ),
  ]
  for (const [name, total, before, level] of counters) {
    const added = total - (before ?? 0)
    if (added > 0) {
      entries.push({ level, message: `${name} +${added} (total ${total})` })
    }
  }
  return entries
}
