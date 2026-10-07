import { useCallback, useEffect, useRef, useState } from 'react'
import { playbackPosition, type RoomSnapshot, type StreamInfo } from '../../shared/types'
import { errorText, request } from './api'
import { bufferChoices, BufferedAudioController, defaultBufferGoal } from './audio-sync'
import { LocalVolumeController } from './audio-volume'
import { AudioFocus } from './audio-focus'

function savedBufferGoal(): number {
  try {
    const value = Number(localStorage.getItem('listen_buffer_seconds'))
    if (bufferChoices.some((choice) => choice === value)) return value
  } catch { /* 私密模式采用默认值。 */ }
  return defaultBufferGoal
}

function savedVolume(): number {
  try {
    const stored = localStorage.getItem('listen_volume')
    if (stored !== null && Number.isFinite(Number(stored))) return Math.max(0, Math.min(1, Number(stored)))
  } catch { /* 默认音量。 */ }
  return 0.7
}

export function useRoomAudio(room: RoomSnapshot | null, connected: boolean, getServerTime: () => number) {
  const [audio] = useState(() => { const player = new Audio(); player.preload = 'auto'; player.volume = 0.7; return player })
  const [enabled, setEnabled] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [volume, setVolumeState] = useState(savedVolume)
  const [volumeControl] = useState(() => new LocalVolumeController(audio, volume))
  const focusRef = useRef<AudioFocus | null>(null)
  const [position, setPosition] = useState(0)
  const [loading, setLoading] = useState(false)
  const [buffered, setBuffered] = useState(0)
  const [bitrate, setBitrate] = useState<number | null>(null)
  const [bufferGoal, setGoal] = useState(savedBufferGoal)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const refreshQueueId = useRef<string | null>(null)
  const loadedId = useRef<string | null>(null)
  const latest = useRef({ room, connected, enabled, blocked, bufferGoal })
  latest.current = { room, connected, enabled, blocked, bufferGoal }
  const failed = useRef(false)
  const current = room?.queue.find((item) => item.id === room.playback.queueId)
  const [controller] = useState(() => new BufferedAudioController(audio, (err) => {
    setLoading(false)
    if ((err as { name?: string })?.name === 'NotAllowedError') {
      setBlocked(true); setError('浏览器需要点击授权播放，请点击「开启声音」')
    } else {
      failed.current = true; setError('音频无法播放，请尝试刷新音频')
    }
  }))

  const reconcile = useCallback((align = false) => {
    const { room: state, connected: online, enabled: listening, blocked: autoplayBlocked, bufferGoal: goal } = latest.current
    if (!state) { audio.pause(); return }
    const item = state.queue.find((q) => q.id === state.playback.queueId)
    const now = getServerTime()
    const target = playbackPosition(state.playback, now, (item?.track.duration || 0) / 1000)
    setPosition(target)
    if (!item || !state.account.connected) { audio.pause(); setLoading(false); setBuffered(0); return }
    if (loadedId.current !== item.id || !audio.getAttribute('src') || failed.current) return
    const status = controller.sync({
      position: target, duration: item.track.duration / 1000, playing: state.playback.playing,
      active: online && listening && !autoplayBlocked, executeReady: now >= state.playback.updatedAt,
      goal, now: performance.now(), align,
    })
    setBuffered(Math.round(status.buffered * 10) / 10)
    setLoading(status.buffering || audio.readyState < 1)
  }, [audio, controller, getServerTime])

  useEffect(() => {
    const abort = new AbortController()
    controller.reset(performance.now())
    audio.removeAttribute('src')
    audio.load()
    loadedId.current = null
    failed.current = false
    setError(''); setBuffered(0); setBitrate(null)
    const refresh = current?.id === refreshQueueId.current
    refreshQueueId.current = null
    if (!room || !current || !room.account.connected) { setLoading(false); return () => abort.abort() }
    setLoading(true)
    const path = `/api/rooms/${room.id}/stream?queueId=${current.id}${refresh ? '&refresh=1' : ''}`
    void request<StreamInfo>(path, { signal: abort.signal }).then((stream) => {
      if (abort.signal.aborted) return
      loadedId.current = current.id
      setBitrate(stream.bitrate ?? null)
      audio.src = stream.url
      audio.load()
    }).catch((err) => { if (!abort.signal.aborted) { failed.current = true; setLoading(false); setError(errorText(err)) } })
    return () => { abort.abort(); controller.reset(performance.now()) }
  }, [audio, controller, room?.id, current?.id, room?.account.connected, retry])

  useEffect(() => {
    // canplay 只表示可继续解码，不应强制 seek，否则会再次触发 waiting。
    const ready = () => reconcile()
    const waiting = () => {
      const state = latest.current
      if (state.enabled && state.connected && state.room?.playback.playing) controller.waiting(performance.now())
      reconcile()
    }
    const failure = () => {
      setLoading(false)
      if (!audio.getAttribute('src')) return
      if (!failed.current) { failed.current = true; setError('音频加载失败，可尝试刷新音频') }
    }
    const events = ['loadedmetadata', 'canplay', 'canplaythrough', 'progress', 'seeked', 'playing'] as const
    for (const event of events) audio.addEventListener(event, ready)
    audio.addEventListener('waiting', waiting)
    audio.addEventListener('error', failure)
    const interval = setInterval(() => reconcile(), 500)
    return () => {
      clearInterval(interval)
      for (const event of events) audio.removeEventListener(event, ready)
      audio.removeEventListener('waiting', waiting)
      audio.removeEventListener('error', failure)
      audio.pause()
    }
  }, [audio, controller, reconcile])

  useEffect(() => {
    const wait = Math.max(0, (room?.playback.updatedAt || 0) - getServerTime())
    const timer = setTimeout(() => reconcile(true), wait)
    return () => clearTimeout(timer)
  }, [room?.playback.revision, connected, enabled, blocked, getServerTime, reconcile])
  const setVolume = useCallback((value: number) => {
    const next = volumeControl.set(value)
    setVolumeState(next)
    try { localStorage.setItem('listen_volume', String(next)) } catch { /* 当前页仍生效。 */ }
  }, [volumeControl])
  const toggleVolume = useCallback(() => setVolume(volumeControl.toggle()), [setVolume, volumeControl])
  useEffect(() => {
    const changed = () => setVolumeState(volumeControl.value)
    audio.addEventListener('volumechange', changed)
    return () => audio.removeEventListener('volumechange', changed)
  }, [audio, volumeControl])
  useEffect(() => { reconcile() }, [bufferGoal, reconcile])

  const unlock = useCallback(() => {
    focusRef.current?.take()
    setEnabled(true); setBlocked(false); setError('')
    latest.current = { ...latest.current, enabled: true, blocked: false }
    if (audio.getAttribute('src') && latest.current.room?.playback.playing) {
      // 在点击手势内申请声音播放权限；随后由缓冲控制器决定何时实际恢复。
      void audio.play().then(() => reconcile()).catch((err: DOMException) => {
        if (err.name === 'NotAllowedError') { setBlocked(true); setError('请再次点击开启声音以授权播放') }
      })
    }
    reconcile(true)
  }, [audio, reconcile])
  const mute = useCallback(() => {
    latest.current = { ...latest.current, enabled: false }
    setEnabled(false); audio.pause()
  }, [audio])

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    const focus = new AudioFocus(new BroadcastChannel('listen_audio_focus'), crypto.randomUUID(), mute)
    focusRef.current = focus
    return () => { focus.close(); if (focusRef.current === focus) focusRef.current = null }
  }, [mute])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return
    navigator.mediaSession.metadata = new MediaMetadata({ title: current.track.title, artist: current.track.artists.join(' / '), album: current.track.album, artwork: current.track.coverUrl ? [{ src: current.track.coverUrl }] : [] })
    navigator.mediaSession.setActionHandler('pause', mute)
    navigator.mediaSession.setActionHandler('play', unlock)
    return () => { navigator.mediaSession.setActionHandler('pause', null); navigator.mediaSession.setActionHandler('play', null); navigator.mediaSession.metadata = null }
  }, [audio, current?.id, mute, unlock])

  const setBufferGoal = useCallback((value: number) => {
    if (!bufferChoices.some((choice) => choice === value)) return
    setGoal(value)
    try { localStorage.setItem('listen_buffer_seconds', String(value)) } catch { /* 当前页面仍会应用。 */ }
  }, [])
  const attach = useCallback((container: HTMLSpanElement | null) => {
    if (container) container.appendChild(audio)
    else audio.remove()
  }, [audio])
  const retryAudio = useCallback(() => {
    refreshQueueId.current = latest.current.room?.playback.queueId || null
    setRetry((n) => n + 1)
  }, [])
  return { attach, enabled, blocked, volume, setVolume, toggleVolume, position, loading, buffered, bitrate, bufferGoal, setBufferGoal, error, unlock, mute, retry: retryAudio }
}
