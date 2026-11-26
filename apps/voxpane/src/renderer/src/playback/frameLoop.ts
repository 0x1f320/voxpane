export interface FrameDemand {
  shown: boolean
  debug: boolean
  probing: boolean
  playing: boolean
  effectsEnabled: boolean
  effectsActive: boolean
}

export function drawsLive(demand: FrameDemand): boolean {
  return (
    demand.shown &&
    (demand.debug || (demand.playing && demand.effectsEnabled) || demand.effectsActive)
  )
}

export function wantsNextFrame(demand: FrameDemand): boolean {
  return (
    demand.effectsActive ||
    (demand.shown && (demand.debug || demand.probing || (demand.playing && demand.effectsEnabled)))
  )
}

export function wakesOnPlayback(demand: FrameDemand): boolean {
  return demand.shown && demand.effectsEnabled && !demand.playing
}

type RequestFrame = (callback: () => void) => number
type CancelFrame = (handle: number) => void

const RETRY_AFTER_THROW = true

export class FrameLoop {
  private handle: number | null = null
  private disposed = false

  constructor(
    private readonly drawFrameAndWantAnother: () => boolean,
    private readonly request: RequestFrame = (callback) => requestAnimationFrame(callback),
    private readonly cancel: CancelFrame = (handle) => cancelAnimationFrame(handle),
  ) {}

  readonly wake = (): void => {
    if (this.disposed || this.handle !== null) {
      return
    }
    this.handle = this.request(this.run)
  }

  dispose(): void {
    this.disposed = true
    if (this.handle !== null) {
      this.cancel(this.handle)
      this.handle = null
    }
  }

  private readonly run = (): void => {
    this.handle = null
    let another = RETRY_AFTER_THROW
    try {
      another = this.drawFrameAndWantAnother()
    } finally {
      if (another) {
        this.wake()
      }
    }
  }
}
