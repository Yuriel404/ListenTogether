import { randomBytes, randomUUID } from 'node:crypto'
import type { ChatMessage, PlayerCommand, RoomSnapshot, StreamInfo, Track } from '../shared/types.js'
import { MAX_QUEUE_TRACKS, playbackPosition } from '../shared/types.js'
import { AppError, publicError } from './errors.js'
import { accountStatus, type AccountInfo, type MusicProvider } from './music.js'
import { checkPassword, hashPassword, Repository, type Session, type StoredRoom } from './repository.js'

export const DEFAULT_ROOM_IDLE_TTL_MS = 24 * 60 * 60 * 1000

export class RoomService {
  readonly rooms = new Map<string, StoredRoom>()
  onChange: (snapshot: RoomSnapshot) => void = () => {}
  onError: (roomId: string, message: string) => void = () => {}
  onClose: (roomId: string) => void = () => {}
  private online = new Map<string, Map<string, number>>()
  private pending = new Map<string, Promise<void>>()
  private streams = new Map<string, StreamInfo>()
  private streamRequests = new Map<string, Promise<StreamInfo>>()
  private streamReads = new Set<Promise<StreamInfo>>()
  private streamVersions = new WeakMap<StoredRoom, number>()
  private queueVersions = new WeakMap<StoredRoom, number>()
  private advancing = new Set<string>()
  private cleanupTask?: Promise<void>
  private readonly idleTtlMs: number
  private readonly maxStreams: number

  constructor(readonly repo: Repository, readonly music: MusicProvider, options: { idleTtlMs?: number; maxStreams?: number } = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_ROOM_IDLE_TTL_MS
    this.maxStreams = options.maxStreams ?? 1000
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs <= 0) throw new Error('房间保留时间必须大于 0')
    if (!Number.isSafeInteger(this.maxStreams) || this.maxStreams < 1) throw new Error('播放地址缓存上限必须为正整数')
    const now = Date.now()
    for (const room of repo.loadRooms()) {
      // 旧版本没有活动时间；首次升级给予一次完整保留期，之后重启不延长截止时间。
      room.lastActiveAt ??= now
      if (!repo.hasActiveSession(room.ownerSessionId, now) || now - room.lastActiveAt >= this.idleTtlMs) {
        repo.deleteRoom(room.id)
        continue
      }
      // 重启后等待房主重新开始，避免无在线浏览器时自行消耗播放队列。
      room.playback.position = playbackPosition(room.playback, now, this.duration(room))
      room.playback.playing = false
      room.playback.updatedAt = now
      room.playback.revision++
      this.rooms.set(room.id, room)
      repo.saveRoom(room)
    }
    repo.pruneExpiredSessions(now)
  }

  private duration(room: StoredRoom): number {
    return (room.queue.find((item) => item.id === room.playback.queueId)?.track.duration || 0) / 1000
  }

  get(roomId: string): StoredRoom {
    const room = this.rooms.get(roomId)
    if (!room) throw new AppError(404, '这个房间不存在或已关闭')
    return room
  }

  member(roomId: string, session: Session): StoredRoom {
    const room = this.get(roomId)
    if (session.expiresAt <= Date.now()) throw new AppError(401, '会话已过期，请刷新页面')
    if (!this.repo.isMember(roomId, session.id)) throw new AppError(403, '请先加入房间')
    return room
  }

  owner(roomId: string, session: Session): StoredRoom {
    const room = this.member(roomId, session)
    if (room.ownerSessionId !== session.id) throw new AppError(403, '只有房主可以执行此操作')
    return room
  }

  async serial<T>(roomId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.pending.get(roomId) || Promise.resolve()
    const result = previous.then(fn)
    const tail = result.then(() => {}, () => {})
    this.pending.set(roomId, tail)
    void tail.then(() => { if (this.pending.get(roomId) === tail) this.pending.delete(roomId) })
    return result
  }

  snapshot(roomId: string): RoomSnapshot {
    const room = this.get(roomId)
    const now = Date.now()
    return {
      id: room.id, name: room.name, createdAt: room.createdAt,
      members: this.repo.members(roomId).map((m) => ({ id: m.id, nickname: m.nickname, role: m.sessionId === room.ownerSessionId ? 'owner' : 'member', online: !!this.online.get(roomId)?.get(m.sessionId) })),
      queue: room.queue.map((item) => ({ ...item, track: { ...item.track, artists: [...item.track.artists] } })),
      playback: { ...room.playback }, account: { ...room.account }, serverTime: now,
    }
  }

  private changed(room: StoredRoom): RoomSnapshot {
    // 上游请求可能在最后一位成员离线后才返回，不能重新启动空房间播放。
    if (!this.online.has(room.id) && room.playback.playing) this.pause(room)
    this.repo.saveRoom(room)
    const state = this.snapshot(room.id)
    this.onChange(state)
    return state
  }

  create(session: Session, name: string, nickname: string, password?: string): RoomSnapshot {
    if ([...this.rooms.values()].filter((r) => r.ownerSessionId === session.id).length >= 5) throw new AppError(400, '每位房主最多保留 5 个房间，请先关闭不用的房间')
    const now = Date.now()
    const room: StoredRoom = {
      id: randomBytes(9).toString('base64url'), ownerSessionId: session.id, name, createdAt: now, lastActiveAt: now,
      queue: [], playback: { queueId: null, playing: false, position: 0, updatedAt: now, revision: 0 },
      account: { connected: false, mode: this.music.mode }, passwordHash: hashPassword(password),
    }
    this.rooms.set(room.id, room)
    this.repo.saveRoom(room)
    this.repo.addMember(room.id, session, nickname)
    return this.snapshot(room.id)
  }

  join(roomId: string, session: Session, nickname: string, password = ''): RoomSnapshot {
    const room = this.get(roomId)
    const existing = this.repo.isMember(roomId, session.id)
    if (!existing && !checkPassword(password, room.passwordHash)) throw new AppError(403, '房间密码不正确')
    if (!existing && this.repo.members(roomId).length >= 50) throw new AppError(400, '房间已达到 50 人上限')
    this.repo.addMember(roomId, session, nickname)
    room.lastActiveAt = Date.now()
    return this.changed(room)
  }

  presence(roomId: string, sessionId: string, connected: boolean): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    const map = this.online.get(roomId) || new Map<string, number>()
    const wasOnline = map.size > 0
    const count = Math.max(0, (map.get(sessionId) || 0) + (connected ? 1 : -1))
    if (count) map.set(sessionId, count); else map.delete(sessionId)
    if (map.size) this.online.set(roomId, map); else this.online.delete(roomId)
    if (connected || wasOnline) room.lastActiveAt = Date.now()
    if (wasOnline && !map.size) this.pause(room)
    this.changed(room)
  }

  async add(roomId: string, session: Session, input: string, playlist = false): Promise<RoomSnapshot> {
    const original = this.member(roomId, session)
    const version = this.queueVersions.get(original)
    const cookie = this.repo.credential(roomId)
    const tracks = playlist ? await this.music.playlist(input, cookie) : [await this.music.track(input, cookie)]
    return this.serial(roomId, () => {
      const room = this.member(roomId, session)
      if (this.queueVersions.get(room) !== version) throw new AppError(409, '歌单已清空，请重新添加歌曲')
      const seen = new Set(room.queue.map((item) => item.track.id))
      const unique = tracks.filter((track) => {
        if (seen.has(track.id)) return false
        seen.add(track.id)
        return true
      })
      if (!unique.length) throw new AppError(400, '这些歌曲已经在播放队列中')
      if (room.queue.length + unique.length > MAX_QUEUE_TRACKS) throw new AppError(400, `队列最多容纳 ${MAX_QUEUE_TRACKS} 首歌曲，当前还可添加 ${MAX_QUEUE_TRACKS - room.queue.length} 首`)
      const nickname = this.repo.members(roomId).find((m) => m.sessionId === session.id)?.nickname || session.nickname
      room.queue.push(...unique.map((track) => ({ id: randomUUID(), track, addedBy: nickname })))
      return this.changed(room)
    })
  }

  remove(roomId: string, session: Session, queueId: string): Promise<RoomSnapshot> {
    return this.serial(roomId, () => {
      const room = this.owner(roomId, session)
      if (room.playback.queueId === queueId) throw new AppError(400, '正在播放的歌曲不能移除，请先切歌')
      const removed = room.queue.find((item) => item.id === queueId)
      room.queue = room.queue.filter((item) => item.id !== queueId)
      if (removed) this.streams.delete(`${roomId}:${removed.track.id}`)
      return this.changed(room)
    })
  }

  clearQueue(roomId: string, session: Session): Promise<RoomSnapshot> {
    return this.serial(roomId, () => {
      const room = this.owner(roomId, session)
      this.queueVersions.set(room, (this.queueVersions.get(room) || 0) + 1)
      room.queue = []
      room.playback = { queueId: null, playing: false, position: 0, updatedAt: Date.now(), revision: room.playback.revision + 1 }
      this.invalidate(roomId)
      return this.changed(room)
    })
  }

  connectAccount(roomId: string, session: Session, account: AccountInfo, isCurrent: () => boolean = () => true): Promise<RoomSnapshot> {
    return this.serial(roomId, () => {
      const room = this.owner(roomId, session)
      if (!isCurrent()) throw new AppError(409, '账号操作已被更新，请使用最新的登录请求')
      this.pause(room)
      room.playback.queueId = null
      room.playback.position = 0
      this.repo.setCredential(roomId, account.cookie)
      room.account = accountStatus(account, this.music.mode)
      this.invalidate(roomId)
      return this.changed(room)
    })
  }

  disconnectAccount(roomId: string, session: Session): Promise<RoomSnapshot> {
    return this.serial(roomId, () => {
      const room = this.owner(roomId, session)
      this.pause(room)
      this.repo.clearCredential(roomId)
      this.invalidate(roomId)
      room.account = { connected: false, mode: this.music.mode }
      return this.changed(room)
    })
  }

  private pause(room: StoredRoom): void {
    const now = Date.now()
    room.playback = { ...room.playback, position: playbackPosition(room.playback, now, this.duration(room)), playing: false, updatedAt: now, revision: room.playback.revision + 1 }
  }

  private invalidate(roomId: string): void {
    const room = this.rooms.get(roomId)
    if (room) this.streamVersions.set(room, (this.streamVersions.get(room) || 0) + 1)
    for (const key of this.streams.keys()) if (key.startsWith(`${roomId}:`)) this.streams.delete(key)
    for (const key of this.streamRequests.keys()) if (key.startsWith(`${roomId}:`)) this.streamRequests.delete(key)
  }

  private async resolveStream(room: StoredRoom, track: Track, refresh = false): Promise<StreamInfo> {
    const cookie = this.repo.credential(room.id)
    if (!cookie || !room.account.connected) throw new AppError(400, '请先让房主连接网易云账号')
    const key = `${room.id}:${track.id}`
    const saved = this.streams.get(key)
    if (!refresh && saved && saved.expiresAt > Date.now() + 15000) {
      this.streams.delete(key)
      this.streams.set(key, saved)
      return saved
    }
    const pending = this.streamRequests.get(key)
    if (pending) return pending
    this.streams.delete(key)
    const version = this.streamVersions.get(room)
    const request = (async () => {
      const stream = await this.music.stream(track, cookie, room.id)
      if (this.rooms.get(room.id) !== room) throw new AppError(404, '这个房间不存在或已关闭')
      if (this.streamVersions.get(room) !== version || !room.queue.some((item) => item.track.id === track.id)) {
        throw new AppError(409, '房间音源或歌单已更新，请重试')
      }
      this.streams.set(key, stream)
      while (this.streams.size > this.maxStreams) this.streams.delete(this.streams.keys().next().value!)
      return stream
    })()
    this.streamRequests.set(key, request)
    const finish = () => { if (this.streamRequests.get(key) === request) this.streamRequests.delete(key) }
    void request.then(finish, finish)
    return request
  }

  stream(roomId: string, session: Session, queueId: string, refresh = false): Promise<StreamInfo> {
    // 读取音源不占用房间写入队列，成员的慢请求不能阻塞房主暂停、解绑或关闭。
    const request = (async () => {
      const room = this.member(roomId, session)
      const version = this.streamVersions.get(room)
      if (room.playback.queueId !== queueId) throw new AppError(409, '歌曲已经切换，请同步房间状态')
      const track = room.queue.find((q) => q.id === queueId)?.track
      if (!track) throw new AppError(404, '没有正在播放的歌曲')
      const stream = await this.resolveStream(room, track, refresh)
      const current = this.member(roomId, session)
      if (current !== room || this.streamVersions.get(current) !== version) throw new AppError(409, '房间音源或歌单已更新，请重试')
      if (current.playback.queueId !== queueId) throw new AppError(409, '歌曲已经切换，请同步房间状态')
      return stream
    })()
    this.streamReads.add(request)
    const finish = () => { this.streamReads.delete(request) }
    void request.then(finish, finish)
    return request
  }

  private async select(room: StoredRoom, index: number): Promise<void> {
    const item = room.queue[index]
    if (!item) throw new AppError(400, '播放队列为空')
    const revision = room.playback.revision
    await this.resolveStream(room, item.track)
    if (room.playback.revision !== revision) return
    room.playback = { queueId: item.id, playing: true, position: 0, updatedAt: Date.now() + 350, revision: room.playback.revision + 1 }
  }

  command(roomId: string, session: Session, command: PlayerCommand): Promise<RoomSnapshot> {
    return this.serial(roomId, async () => {
      const room = this.owner(roomId, session)
      const index = room.queue.findIndex((item) => item.id === room.playback.queueId)
      if (command.type === 'select') {
        const target = room.queue.findIndex((item) => item.id === command.queueId)
        if (target < 0) throw new AppError(404, '这首歌不在队列中')
        await this.select(room, target)
      } else if (command.type === 'next' || command.type === 'previous') {
        if (!room.queue.length) throw new AppError(400, '请先添加歌曲')
        const next = index < 0 ? 0 : (index + (command.type === 'next' ? 1 : -1) + room.queue.length) % room.queue.length
        await this.select(room, next)
      } else if (command.type === 'play' && index < 0) {
        await this.select(room, 0)
      } else {
        const item = room.queue[index]
        if (!item) throw new AppError(400, '请先选择歌曲')
        if (command.type === 'play') {
          const revision = room.playback.revision
          await this.resolveStream(room, item.track)
          if (room.playback.revision !== revision) return this.changed(room)
        }
        const executeAt = Date.now() + 350
        const position = command.type === 'seek' ? Math.min(item.track.duration / 1000, Math.max(0, command.position || 0)) : playbackPosition(room.playback, executeAt, item.track.duration / 1000)
        room.playback = {
          ...room.playback, position: command.type === 'play' && position >= item.track.duration / 1000 ? 0 : position,
          playing: command.type === 'play' ? true : command.type === 'pause' ? false : room.playback.playing,
          updatedAt: executeAt, revision: room.playback.revision + 1,
        }
      }
      return this.changed(room)
    })
  }

  chat(roomId: string, session: Session, text: string): ChatMessage {
    this.member(roomId, session)
    const nickname = this.repo.members(roomId).find((m) => m.sessionId === session.id)?.nickname || session.nickname
    const message = { id: randomUUID(), nickname, userId: session.publicId, text, sentAt: Date.now() }
    this.repo.saveMessage(roomId, message)
    return message
  }

  close(roomId: string, session: Session): Promise<void> {
    return this.serial(roomId, () => {
      this.owner(roomId, session)
      this.destroy(roomId)
    })
  }

  private destroy(roomId: string): void {
    this.repo.deleteRoom(roomId)
    this.rooms.delete(roomId)
    this.online.delete(roomId)
    this.invalidate(roomId)
    this.onClose(roomId)
  }

  cleanup(): Promise<void> {
    // 防止慢音源请求使每分钟的清理任务反复排队。
    if (this.cleanupTask) return this.cleanupTask
    this.cleanupTask = this.sweep().finally(() => { this.cleanupTask = undefined })
    return this.cleanupTask
  }

  private async sweep(): Promise<void> {
    for (const [key, stream] of this.streams) if (stream.expiresAt <= Date.now()) this.streams.delete(key)
    await Promise.all([...this.rooms.keys()].map((id) => this.serial(id, () => {
      const room = this.rooms.get(id)
      if (!room) return
      const now = Date.now()
      if (!this.repo.hasActiveSession(room.ownerSessionId, now) || (!this.online.has(id) && now - (room.lastActiveAt ?? room.createdAt) >= this.idleTtlMs)) {
        this.destroy(id)
      } else if (this.online.has(id)) {
        // 持久化在线心跳，异常重启后仍可使用最近活动时间判断保留期限。
        room.lastActiveAt = now
        this.repo.saveRoom(room)
      }
    })))
    this.repo.pruneExpiredSessions()
  }

  async drain(): Promise<void> {
    await this.cleanupTask
    await Promise.allSettled(this.streamReads)
    await Promise.all(this.pending.values())
  }

  tick(): void {
    for (const id of this.online.keys()) {
      const room = this.rooms.get(id)
      if (!room) continue
      if (!room.playback.playing || this.advancing.has(room.id)) continue
      const duration = this.duration(room)
      if (!duration || playbackPosition(room.playback, Date.now(), duration) < duration) continue
      const revision = room.playback.revision
      this.advancing.add(room.id)
      void this.serial(room.id, async () => {
        if (!this.rooms.has(room.id) || !this.online.has(room.id) || room.playback.revision !== revision) return
        const index = room.queue.findIndex((q) => q.id === room.playback.queueId)
        try {
          if (index + 1 < room.queue.length) await this.select(room, index + 1)
          else this.pause(room)
        } catch (error) {
          this.pause(room)
          this.onError(room.id, publicError(error))
        }
        this.changed(room)
      }).catch((error) => this.onError(room.id, publicError(error))).finally(() => this.advancing.delete(room.id))
    }
  }
}
