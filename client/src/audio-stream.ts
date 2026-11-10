import type { StreamInfo } from '../../shared/types'

export interface AudioStreamTarget {
  roomId: string
  queueId: string
}

interface StreamCallbacks {
  reset(): void
  pause(): void
  loading(): void
  loaded(stream: StreamInfo, target: AudioStreamTarget): void
  error(error: unknown): void
}

type StreamRequest = (target: AudioStreamTarget, refresh: boolean, signal: AbortSignal) => Promise<StreamInfo>

/** 将音源请求与 Socket 状态协调；重连保留可用音源，刷新只影响当前这一次请求。 */
export class AudioStreamLoader {
  private target: AudioStreamTarget | null = null
  private connected = false
  private loaded = false
  private pending?: AbortController

  constructor(private request: StreamRequest, private callbacks: StreamCallbacks) {}

  update(target: AudioStreamTarget | null, connected: boolean): void {
    const changed = target?.roomId !== this.target?.roomId || target?.queueId !== this.target?.queueId
    this.connected = connected
    if (changed) {
      this.cancel()
      this.target = target
      this.loaded = false
      if (!target || !connected) this.callbacks.reset()
    }
    if (!connected) {
      this.cancel()
      this.callbacks.pause()
      return
    }
    if (this.target && !this.loaded && !this.pending) this.start(false)
  }

  retry(): void {
    if (this.target && this.connected) this.start(true)
  }

  markFailed(): void { this.loaded = false }

  dispose(): void {
    this.cancel()
    this.target = null
    this.loaded = false
    this.connected = false
  }

  private cancel(): void {
    this.pending?.abort()
    this.pending = undefined
  }

  private start(refresh: boolean): void {
    const target = this.target!
    this.cancel()
    this.loaded = false
    this.callbacks.reset()
    this.callbacks.loading()
    const abort = new AbortController()
    this.pending = abort
    void Promise.resolve().then(() => {
      if (abort.signal.aborted) return undefined
      return this.request(target, refresh, abort.signal)
    }).then((stream) => {
      if (this.pending !== abort || abort.signal.aborted || !stream) return
      this.pending = undefined
      this.loaded = true
      this.callbacks.loaded(stream, target)
    }).catch((error: unknown) => {
      if (this.pending !== abort || abort.signal.aborted) return
      this.pending = undefined
      this.callbacks.error(error)
    })
  }
}
