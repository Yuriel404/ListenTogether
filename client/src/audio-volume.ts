interface VolumeOutput { volume: number; muted: boolean }

/** 音量立即作用于同一个播放器；静音恢复用户上次的非零音量。 */
export class LocalVolumeController {
  private previous = 0.7
  constructor(private audio: VolumeOutput, initial = 0.7) { this.set(initial) }

  get value(): number { return this.audio.muted ? 0 : this.audio.volume }

  set(value: number): number {
    if (!Number.isFinite(value)) return this.value
    const next = Math.min(1, Math.max(0, value))
    if (next > 0) this.previous = next
    this.audio.volume = next
    this.audio.muted = next === 0
    return next
  }

  toggle(): number { return this.set(this.value > 0 ? 0 : this.previous) }
}
