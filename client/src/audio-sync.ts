export const bufferChoices = [15, 30, 60] as const
export const defaultBufferGoal = 30

interface BufferedRanges {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export interface AudioOutput {
  currentTime: number
  readonly duration: number
  readonly readyState: number
  readonly networkState: number
  readonly seeking: boolean
  readonly paused: boolean
  playbackRate: number
  readonly buffered: BufferedRanges
  pause(): void
  play(): Promise<void>
}

/** 只计算当前位置所在的连续缓冲段，不能把远处的片段当成可播放缓存。 */
export function bufferedSeconds(ranges: BufferedRanges, position: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= position + 0.05 && ranges.end(i) > position) return ranges.end(i) - position
  }
  return 0
}

interface SyncInput {
  position: number
  duration: number
  playing: boolean
  active: boolean
  executeReady: boolean
  goal: number
  now: number
  align?: boolean
}

/** 缓冲期间保持下载位置稳定；恢复时才对齐房间时间，避免 canplay → seek → waiting 循环。 */
export class BufferedAudioController {
  private buffering = true
  private alignPending = true
  private bufferSince = 0
  private lastSeek = -Infinity
  private playPending = false
  private generation = 0

  constructor(private audio: AudioOutput, private onPlayError: (error: unknown) => void = () => {}) {}

  reset(now: number): void {
    this.generation++
    this.playPending = false
    this.buffering = true
    this.alignPending = true
    this.bufferSince = now
    this.lastSeek = -Infinity
    this.audio.pause()
    this.audio.playbackRate = 1
  }

  waiting(now: number): void {
    // 浏览器在 seek 时也会派发 waiting，这不是网络断粮。
    if (this.audio.seeking || this.audio.readyState >= 3) return
    this.enterBuffering(now)
  }

  private enterBuffering(now: number): void {
    if (!this.buffering) this.bufferSince = now
    this.buffering = true
    this.audio.pause()
    this.audio.playbackRate = 1
  }

  private seek(position: number, now: number): void {
    if (Math.abs(this.audio.currentTime - position) <= 0.25) return
    try { this.audio.currentTime = position; this.lastSeek = now } catch { /* 元数据未就绪时稍后重试。 */ }
  }

  private play(): void {
    if (!this.audio.paused || this.playPending) return
    const generation = this.generation
    this.playPending = true
    void this.audio.play().catch((error: unknown) => {
      if (generation === this.generation && (error as { name?: string })?.name !== 'AbortError') this.onPlayError(error)
    }).finally(() => { if (generation === this.generation) this.playPending = false })
  }

  sync(input: SyncInput): { buffering: boolean; buffered: number } {
    const audio = this.audio
    const duration = Math.min(input.duration || Infinity, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity)
    const target = Math.min(duration, Math.max(0, input.position))
    const remaining = Math.max(0, duration - target)
    const ahead = bufferedSeconds(audio.buffered, target)
    const status = (buffering: boolean) => ({ buffering, buffered: ahead })

    if (!input.active) { audio.pause(); audio.playbackRate = 1; return status(false) }
    if (!input.executeReady) return status(this.buffering)
    if (!input.playing || remaining <= 0.05) {
      audio.pause(); audio.playbackRate = 1
      this.buffering = true
      this.bufferSince = input.now
      if (input.align && audio.readyState >= 1 && !audio.seeking) this.seek(target, input.now)
      return status(false)
    }
    if (input.align && Math.abs(target - audio.currentTime) > 0.25) {
      this.alignPending = true
      this.enterBuffering(input.now)
    }
    if (audio.readyState < 1) return status(true)
    if (this.alignPending && !audio.seeking) {
      this.seek(target, input.now)
      this.alignPending = false
    }
    if (audio.seeking) return status(true)

    const localAhead = bufferedSeconds(audio.buffered, audio.currentTime)
    if (!this.buffering && remaining > 2 && (audio.readyState < 3 || localAhead < 1.5)) this.enterBuffering(input.now)
    if (this.buffering) {
      // 浏览器可限制 preload。等 8 秒后允许以至少 5 秒缓存恢复，避免无限显示加载中。
      const goal = Math.min(input.goal, remaining)
      const fallback = Math.min(5, remaining)
      const waited = input.now - this.bufferSince
      const enough = ahead >= goal - 0.05 || ((waited >= 8000 || audio.networkState === 1) && ahead >= fallback - 0.05)
      if (!enough || audio.readyState < 3) {
        // 长时间完全没有目标区间时才重新定位，不能每个同步 tick 都跳到更远处。
        if (ahead === 0 && Math.abs(target - audio.currentTime) > 2 && waited >= 8000 && input.now - this.lastSeek >= 8000) this.seek(target, input.now)
        return status(true)
      }
      this.buffering = false
      this.seek(target, input.now)
      audio.playbackRate = 1
      this.play()
      return status(false)
    }

    const drift = target - audio.currentTime
    // 只有明显偏离且目标已缓存时才硬校正，微小误差用平缓变速吸收。
    if (Math.abs(drift) > 2 && input.now - this.lastSeek >= 8000) {
      if (ahead < Math.min(5, remaining)) { this.enterBuffering(input.now); this.seek(target, input.now); return status(true) }
      this.seek(target, input.now)
      audio.playbackRate = 1
    } else {
      const rate = Math.abs(drift) > 0.15 ? Math.max(0.98, Math.min(1.02, 1 + drift * 0.02)) : 1
      if (Math.abs(audio.playbackRate - rate) > 0.002) audio.playbackRate = rate
    }
    this.play()
    return status(false)
  }
}
