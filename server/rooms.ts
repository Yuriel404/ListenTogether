import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { ChatMessage, PlayerCommand, RoomSnapshot, StreamInfo, Track } from '../shared/types.js'
import { playbackModes, playbackPosition } from '../shared/types.js'
import { AppError, publicError } from './errors.js'
import { accountStatus, type AccountInfo, type MusicProvider } from './music.js'
import { checkPassword, hashPassword, Repository, type Session, type StoredRoom } from './repository.js'

export class RoomService {
  readonly rooms = new Map<string, StoredRoom>()
  onChange: (snapshot: RoomSnapshot) => void = () => {}
  onError: (roomId: string, message: string) => void = () => {}
  private online = new Map<string, Map<string, number>>()
  private pending = new Map<string, Promise<void>>()
  private streams = new Map<string, StreamInfo>()
  private advancing = new Set<string>()
  private shuffleOrders = new Map<string, { queueIds: string[]; history: string[]; cursor: number }>()

  constructor(readonly repo: Repository, readonly music: MusicProvider) {
    for (const room of repo.loadRooms()) {
      if (!playbackModes.includes(room.playbackMode)) room.playbackMode = 'sequence'
      // 重启后等待房主重新开始，避免无在线浏览器时自行消耗播放队列。
      room.playback.position = playbackPosition(room.playback, Date.now(), this.duration(room))
      room.playback.playing = false
      room.playback.updatedAt = Date.now()
      room.playback.revision++
      this.rooms.set(room.id, room)
      repo.saveRoom(room)
    }
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
      playback: { ...room.playback }, playbackMode: room.playbackMode, account: { ...room.account }, serverTime: now,
    }
  }

  private changed(room: StoredRoom): RoomSnapshot {
    this.repo.saveRoom(room)
    const state = this.snapshot(room.id)
    this.onChange(state)
    return state
  }

  create(session: Session, name: string, nickname: string, password?: string): RoomSnapshot {
    if ([...this.rooms.values()].filter((r) => r.ownerSessionId === session.id).length >= 5) throw new AppError(400, '每位房主最多保留 5 个房间，请先关闭不用的房间')
    const now = Date.now()
    const room: StoredRoom = {
      id: randomBytes(9).toString('base64url'), ownerSessionId: session.id, name, createdAt: now,
      queue: [], playback: { queueId: null, playing: false, position: 0, updatedAt: now, revision: 0 }, playbackMode: 'sequence',
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
    return this.changed(room)
  }

  presence(roomId: string, sessionId: string, connected: boolean): void {
    if (!this.rooms.has(roomId)) return
    const map = this.online.get(roomId) || new Map<string, number>()
    const count = Math.max(0, (map.get(sessionId) || 0) + (connected ? 1 : -1))
    if (count) map.set(sessionId, count); else map.delete(sessionId)
    if (map.size) this.online.set(roomId, map); else this.online.delete(roomId)
    this.onChange(this.snapshot(roomId))
  }

  async add(roomId: string, session: Session, input: string, playlist = false): Promise<RoomSnapshot> {
    this.member(roomId, session)
    const cookie = this.repo.credential(roomId)
    const tracks = playlist ? await this.music.playlist(input, cookie) : [await this.music.track(input, cookie)]
    return this.serial(roomId, () => {
      const room = this.member(roomId, session)
      const unique = tracks.filter((t) => !room.queue.some((q) => q.track.id === t.id))
      if (!unique.length) throw new AppError(400, '这些歌曲已经在播放队列中')
      if (room.queue.length + unique.length > 200) throw new AppError(400, '队列最多容纳 200 首歌曲')
      const nickname = this.repo.members(roomId).find((m) => m.sessionId === session.id)?.nickname || session.nickname
      room.queue.push(...unique.map((track) => ({ id: randomUUID(), track, addedBy: nickname })))
      return this.changed(room)
    })
  }

  remove(roomId: string, session: Session, queueId: string): Promise<RoomSnapshot> {
    return this.serial(roomId, () => {
      const room = this.owner(roomId, session)
      if (room.playback.queueId === queueId) throw new AppError(400, '正在播放的歌曲不能移除，请先切歌')
      room.queue = room.queue.filter((item) => item.id !== queueId)
      return this.changed(room)
    })
  }

  connectAccount(roomId: string, session: Session, account: AccountInfo): Promise<RoomSnapshot> {
    return this.serial(roomId, () => {
      const room = this.owner(roomId, session)
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
    for (const key of this.streams.keys()) if (key.startsWith(`${roomId}:`)) this.streams.delete(key)
  }

  private async resolveStream(room: StoredRoom, track: Track, refresh = false): Promise<StreamInfo> {
    const cookie = this.repo.credential(room.id)
    if (!cookie || !room.account.connected) throw new AppError(400, '请先让房主连接网易云账号')
    const key = `${room.id}:${track.id}`
    const saved = this.streams.get(key)
    if (!refresh && saved && saved.expiresAt > Date.now() + 15000) return saved
    const stream = await this.music.stream(track, cookie, room.id)
    this.streams.set(key, stream)
    return stream
  }

  stream(roomId: string, session: Session, queueId: string, refresh = false): Promise<StreamInfo> {
    return this.serial(roomId, async () => {
      const room = this.member(roomId, session)
      if (room.playback.queueId !== queueId) throw new AppError(409, '歌曲已经切换，请同步房间状态')
      const track = room.queue.find((q) => q.id === queueId)?.track
      if (!track) throw new AppError(404, '没有正在播放的歌曲')
      return this.resolveStream(room, track, refresh)
    })
  }

  private async select(room: StoredRoom, index: number, randomCursor?: number): Promise<void> {
    const item = room.queue[index]
    if (!item) throw new AppError(400, '播放队列为空')
    await this.resolveStream(room, item.track)
    room.playback = { queueId: item.id, playing: true, position: 0, updatedAt: Date.now() + 350, revision: room.playback.revision + 1 }
    if (room.playbackMode === 'random') {
      const order = this.shuffleOrders.get(room.id)
      if (randomCursor === undefined || !order) this.shuffleOrders.delete(room.id)
      else {
        order.cursor = randomCursor
        // 只保留最近的播放历史及当前随机轮次，防止长期播放无限增长。
        if (order.cursor > 400) {
          const removed = order.cursor - 200
          order.history.splice(0, removed)
          order.cursor -= removed
        }
      }
    }
  }

  private shuffled(ids: string[]): string[] {
    ids = [...ids]
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
    }
    return ids
  }

  private adjacent(room: StoredRoom, direction: 1 | -1): { index: number; cursor?: number } {
    const index = room.queue.findIndex((item) => item.id === room.playback.queueId)
    if (room.playbackMode !== 'random') return { index: index < 0 ? 0 : (index + direction + room.queue.length) % room.queue.length }
    const ids = room.queue.map((item) => item.id), currentId = index < 0 ? null : room.playback.queueId
    let order = this.shuffleOrders.get(room.id)
    if (!order || order.queueIds.length !== ids.length || !ids.every((id) => order!.queueIds.includes(id)) || (order.history[order.cursor] || null) !== currentId) {
      const remaining = this.shuffled(ids.filter((id) => id !== currentId))
      order = { queueIds: ids, history: currentId ? [currentId, ...remaining] : remaining, cursor: currentId ? 0 : -1 }
      this.shuffleOrders.set(room.id, order)
    }
    let cursor = order.cursor + direction
    if (cursor >= order.history.length) {
      const round = this.shuffled(ids)
      if (round.length > 1 && round[0] === currentId) {
        const swap = randomInt(1, round.length)
        ;[round[0], round[swap]] = [round[swap], round[0]]
      }
      order.history.push(...round)
    }
    if (order.cursor < 0) cursor = 0
    else if (cursor < 0) cursor = order.history.length - 1
    return { index: room.queue.findIndex((item) => item.id === order!.history[cursor]), cursor }
  }

  private async advance(room: StoredRoom, direction: 1 | -1): Promise<void> {
    const next = this.adjacent(room, direction)
    await this.select(room, next.index, next.cursor)
  }

  command(roomId: string, session: Session, command: PlayerCommand): Promise<RoomSnapshot> {
    return this.serial(roomId, async () => {
      const room = command.type === 'play' || command.type === 'pause' ? this.owner(roomId, session) : this.member(roomId, session)
      if (command.type === 'mode') {
        if (!command.mode || !playbackModes.includes(command.mode)) throw new AppError(400, '请选择有效的播放方式')
        room.playbackMode = command.mode
        this.shuffleOrders.delete(room.id)
        // 修改播放方式不更改当前播放基准，避免让客户端重新跳转或暂停。
        return this.changed(room)
      }
      if (!room.account.connected) throw new AppError(400, '请先让房主连接网易云账号')
      const index = room.queue.findIndex((item) => item.id === room.playback.queueId)
      if (command.type === 'select') {
        const target = room.queue.findIndex((item) => item.id === command.queueId)
        if (target < 0) throw new AppError(404, '这首歌不在队列中')
        await this.select(room, target)
      } else if (command.type === 'next' || command.type === 'previous') {
        if (!room.queue.length) throw new AppError(400, '请先添加歌曲')
        await this.advance(room, command.type === 'next' ? 1 : -1)
      } else if (command.type === 'play' && index < 0) {
        await this.advance(room, 1)
      } else {
        const item = room.queue[index]
        if (!item) throw new AppError(400, '请先选择歌曲')
        if (command.type === 'play') await this.resolveStream(room, item.track)
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
      this.repo.deleteRoom(roomId)
      this.rooms.delete(roomId)
      this.online.delete(roomId)
      this.shuffleOrders.delete(roomId)
      this.invalidate(roomId)
    })
  }

  tick(): void {
    for (const room of this.rooms.values()) {
      if (!room.playback.playing || this.advancing.has(room.id)) continue
      const duration = this.duration(room)
      if (!duration || playbackPosition(room.playback, Date.now(), duration) < duration) continue
      const revision = room.playback.revision
      this.advancing.add(room.id)
      void this.serial(room.id, async () => {
        if (!this.rooms.has(room.id) || room.playback.revision !== revision) return
        const index = room.queue.findIndex((q) => q.id === room.playback.queueId)
        try {
          if (room.playbackMode !== 'sequence' || index + 1 < room.queue.length) await this.advance(room, 1)
          else this.pause(room)
        } catch (error) {
          this.pause(room)
          this.onError(room.id, publicError(error))
        }
        this.changed(room)
      }).finally(() => this.advancing.delete(room.id))
    }
  }
}
