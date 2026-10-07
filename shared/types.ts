export interface Track {
  id: string
  title: string
  artists: string[]
  album: string
  coverUrl: string
  duration: number
  vip: boolean
}

export interface QueueItem {
  id: string
  track: Track
  addedBy: string
}

export interface Playback {
  queueId: string | null
  playing: boolean
  position: number
  updatedAt: number
  revision: number
}

export interface Member {
  id: string
  nickname: string
  role: 'owner' | 'member'
  online: boolean
}

export const playbackModes = ['sequence', 'loop', 'random'] as const
export type PlaybackMode = typeof playbackModes[number]

export interface AccountStatus {
  connected: boolean
  nickname?: string
  avatarUrl?: string
  vipType?: number
  mode: 'netease' | 'demo'
}

export interface RoomSnapshot {
  id: string
  name: string
  createdAt: number
  members: Member[]
  queue: QueueItem[]
  playback: Playback
  playbackMode: PlaybackMode
  account: AccountStatus
  serverTime: number
}

export interface ChatMessage {
  id: string
  nickname: string
  userId: string
  text: string
  sentAt: number
}

export interface SessionInfo {
  user: { id: string; nickname: string }
  csrfToken: string
  provider: 'netease' | 'demo'
}

export type PlayerCommand = {
  type: 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'select' | 'mode'
  queueId?: string
  position?: number
  mode?: PlaybackMode
}

export type Ack<T = undefined> = { ok: true; data: T } | { ok: false; error: string }

export interface StreamInfo {
  url: string
  expiresAt: number
  bitrate?: number
}

/** position 为秒，歌曲 duration 为毫秒；updatedAt 也可表示尚未到达的计划执行时间。 */
export function playbackPosition(playback: Playback, serverNow: number, duration = Infinity): number {
  const elapsed = playback.playing ? Math.max(0, serverNow - playback.updatedAt) / 1000 : 0
  return Math.min(duration, Math.max(0, playback.position + elapsed))
}
