export type CanvasReadOutcome = "found" | "missing" | "failed"

export type CanvasReadReporter = (outcome: CanvasReadOutcome, error?: unknown) => void

/** Reports only changes of outcome: the reader runs every ~250 ms. */
export function reportCanvasReadChanges<T>(
  read: () => Promise<T | null>,
  report: CanvasReadReporter,
): () => Promise<T | null> {
  let last: CanvasReadOutcome | null = null
  const settle = (outcome: CanvasReadOutcome, error?: unknown) => {
    if (outcome !== last) {
      last = outcome
      report(outcome, error)
    }
  }
  return async () => {
    try {
      const snapshot = await read()
      settle(snapshot ? "found" : "missing")
      return snapshot
    } catch (error) {
      settle("failed", error)
      throw error
    }
  }
}
