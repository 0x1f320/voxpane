import { describe, expect, it } from "vitest"
import {
  drawsLive,
  type FrameDemand,
  FrameLoop,
  wakesOnPlayback,
  wantsNextFrame,
} from "./frameLoop"

const IDLE: FrameDemand = {
  shown: true,
  debug: false,
  probing: false,
  playing: false,
  effectsEnabled: true,
  effectsActive: false,
}

function demand(fields: Partial<FrameDemand>): FrameDemand {
  return { ...IDLE, ...fields }
}

describe("wantsNextFrame", () => {
  it("stops when nothing is playing and nothing is in flight", () => {
    expect(wantsNextFrame(IDLE)).toBe(false)
  })

  it("runs while playback has an effect to feed", () => {
    expect(wantsNextFrame(demand({ playing: true }))).toBe(true)
  })

  it("stops during playback when every effect is off", () => {
    expect(wantsNextFrame(demand({ playing: true, effectsEnabled: false }))).toBe(false)
  })

  it("stops during playback behind a hidden window", () => {
    expect(wantsNextFrame(demand({ playing: true, shown: false }))).toBe(false)
  })

  it("keeps running until what is in flight has finished, shown or not", () => {
    expect(wantsNextFrame(demand({ effectsActive: true }))).toBe(true)
    expect(wantsNextFrame(demand({ effectsActive: true, shown: false }))).toBe(true)
    expect(wantsNextFrame(demand({ effectsActive: true, effectsEnabled: false }))).toBe(true)
  })

  it("runs for the debug view and the latency probe only while shown", () => {
    expect(wantsNextFrame(demand({ debug: true }))).toBe(true)
    expect(wantsNextFrame(demand({ probing: true }))).toBe(true)
    expect(wantsNextFrame(demand({ debug: true, probing: true, shown: false }))).toBe(false)
  })
})

describe("drawsLive", () => {
  it("places nothing while stopped with nothing in flight", () => {
    expect(drawsLive(IDLE)).toBe(false)
  })

  it("places effects during playback, and lets them finish in place after it", () => {
    expect(drawsLive(demand({ playing: true }))).toBe(true)
    expect(drawsLive(demand({ effectsActive: true }))).toBe(true)
  })

  it("places the debug view whether or not anything plays", () => {
    expect(drawsLive(demand({ debug: true, effectsEnabled: false }))).toBe(true)
  })

  it("places nothing behind a hidden window, even with effects in flight", () => {
    expect(
      drawsLive(demand({ playing: true, effectsActive: true, debug: true, shown: false })),
    ).toBe(false)
  })

  it("does not place for the latency probe alone", () => {
    expect(drawsLive(demand({ probing: true }))).toBe(false)
  })
})

describe("wakesOnPlayback", () => {
  it("is armed when playback starting is what the loop is waiting for", () => {
    expect(wakesOnPlayback(IDLE)).toBe(true)
  })

  it("is not armed while playback is already running", () => {
    expect(wakesOnPlayback(demand({ playing: true, shown: false }))).toBe(false)
    expect(wakesOnPlayback(demand({ playing: true, effectsEnabled: false }))).toBe(false)
  })

  it("is not armed when playback would still leave nothing to draw", () => {
    expect(wakesOnPlayback(demand({ shown: false }))).toBe(false)
    expect(wakesOnPlayback(demand({ effectsEnabled: false }))).toBe(false)
  })
})

function scheduler() {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    request: (callback: () => void) => {
      const handle = next
      next += 1
      pending.set(handle, callback)
      return handle
    },
    cancel: (handle: number) => {
      pending.delete(handle)
    },
    get queued() {
      return pending.size
    },
    refresh() {
      const due = [...pending.values()]
      pending.clear()
      for (const callback of due) {
        callback()
      }
    },
  }
}

describe("FrameLoop", () => {
  it("asks for no frame until it is woken", () => {
    const raf = scheduler()
    new FrameLoop(() => true, raf.request, raf.cancel)

    expect(raf.queued).toBe(0)
  })

  it("keeps asking while the frame wants another", () => {
    const raf = scheduler()
    let frames = 0
    const loop = new FrameLoop(
      () => {
        frames += 1
        return true
      },
      raf.request,
      raf.cancel,
    )

    loop.wake()
    raf.refresh()
    raf.refresh()
    raf.refresh()

    expect(frames).toBe(3)
    expect(raf.queued).toBe(1)
  })

  it("stops asking once a frame wants no more, and starts again when woken", () => {
    const raf = scheduler()
    let frames = 0
    let more = false
    const loop = new FrameLoop(
      () => {
        frames += 1
        return more
      },
      raf.request,
      raf.cancel,
    )

    loop.wake()
    raf.refresh()
    expect(frames).toBe(1)
    expect(raf.queued).toBe(0)

    more = true
    loop.wake()
    raf.refresh()
    expect(frames).toBe(2)
    expect(raf.queued).toBe(1)
  })

  it("queues one frame however often it is woken", () => {
    const raf = scheduler()
    let frames = 0
    const loop = new FrameLoop(
      () => {
        frames += 1
        return false
      },
      raf.request,
      raf.cancel,
    )

    loop.wake()
    loop.wake()
    loop.wake()
    expect(raf.queued).toBe(1)

    raf.refresh()
    expect(frames).toBe(1)
  })

  it("draws the frame after a wake that arrives while one is drawing", () => {
    const raf = scheduler()
    let frames = 0
    const loop: FrameLoop = new FrameLoop(
      () => {
        frames += 1
        if (frames === 1) {
          loop.wake()
        }
        return false
      },
      raf.request,
      raf.cancel,
    )

    loop.wake()
    raf.refresh()
    expect(raf.queued).toBe(1)

    raf.refresh()
    expect(frames).toBe(2)
    expect(raf.queued).toBe(0)
  })

  it("keeps running through a frame that throws", () => {
    const raf = scheduler()
    let frames = 0
    const loop = new FrameLoop(
      () => {
        frames += 1
        if (frames === 1) {
          throw new Error("frame failed")
        }
        return true
      },
      raf.request,
      raf.cancel,
    )

    loop.wake()
    expect(() => raf.refresh()).toThrow("frame failed")
    expect(raf.queued).toBe(1)

    raf.refresh()
    expect(frames).toBe(2)
  })

  it("cancels its pending frame and ignores wakes once disposed", () => {
    const raf = scheduler()
    let frames = 0
    const loop = new FrameLoop(
      () => {
        frames += 1
        return true
      },
      raf.request,
      raf.cancel,
    )

    loop.wake()
    loop.dispose()
    loop.wake()
    raf.refresh()

    expect(frames).toBe(0)
    expect(raf.queued).toBe(0)
  })
})
