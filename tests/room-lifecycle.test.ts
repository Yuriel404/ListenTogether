import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { StreamInfo, Track } from '../shared/types.js'
import { Repository } from '../server/repository.js'
import { DemoProvider, demoTracks } from '../server/music.js'
import { RoomService } from '../server/rooms.js'

const start = Date.UTC(2026, 10, 3)
const day = 86400_000

class TestMusic extends DemoProvider {
  calls: string[] = []
  beforeStream?: () => Promise<void>

  async track(input: string) { return { ...demoTracks[0], id: input } }
  async stream(track: Track, _cookie: string, roomId: string): Promise<StreamInfo> {
    this.calls.push(`${roomId}:${track.id}`)
    await this.beforeStream?.()
    return { url: `https://audio.example/${roomId}/${track.id}`, expiresAt: Date.now() + 3600_000 }
  }
}

function setup(t: TestContext, options: { idleTtlMs?: number; maxStreams?: number } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const repo = new Repository(':memory:', randomBytes(32))
  t.after(() => repo.close())
  const music = new TestMusic(), rooms = new RoomService(repo, music, options)
  const { session: owner } = repo.createSession()
  const room = rooms.create(owner, '生命周期测试', '房主')
  return { repo, music, rooms, owner, id: room.id }
}

// 直接检查缓存条数，防止只验证音源可用而漏掉已过期对象的内存留存。
function cache(rooms: RoomService): Map<string, StreamInfo> {
  return (rooms as unknown as { streams: Map<string, StreamInfo> }).streams
}

function blockNextStream(music: TestMusic) {
  let release!: () => void, started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  music.beforeStream = async () => { music.beforeStream = undefined; started(); await gate }
  return { entered, release }
}

test('从未建立连接的房间默认保留 24 小时，回收时删除全部关联数据且只通知一次', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  rooms.chat(id, owner, '需要随房间删除')
  const closed: string[] = []
  rooms.onClose = (roomId) => closed.push(roomId)
  t.mock.timers.setTime(start + day - 1)
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), true)
  t.mock.timers.setTime(start + day)
  await rooms.cleanup()
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), false)
  assert.equal(repo.loadRooms().length, 0)
  assert.equal(repo.isMember(id, owner.id), false)
  assert.equal(repo.credential(id), null)
  assert.deepEqual(repo.messages(id), [])
  assert.deepEqual(closed, [id])
})

test('多标签和其他成员在线时保留播放，最后连接离开后暂停，重连重新计算保留期限', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t, { idleTtlMs: 1000 })
  const { session: guest } = repo.createSession()
  rooms.join(id, guest, '朋友')
  rooms.presence(id, owner.id, true)
  rooms.presence(id, owner.id, true)
  rooms.presence(id, guest.id, true)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  await rooms.add(id, owner, '1')
  await rooms.command(id, owner, { type: 'play' })
  rooms.presence(id, owner.id, false)
  assert.equal(rooms.snapshot(id).members.find((member) => member.role === 'owner')?.online, true)
  assert.equal(rooms.get(id).playback.playing, true)
  rooms.presence(id, owner.id, false)
  assert.equal(rooms.get(id).playback.playing, true)
  t.mock.timers.setTime(start + 3000)
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), true)
  rooms.presence(id, guest.id, false)
  assert.equal(rooms.get(id).playback.playing, false)
  t.mock.timers.setTime(start + 3999)
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), true)
  rooms.presence(id, owner.id, true)
  assert.equal(rooms.get(id).playback.playing, false)
  rooms.presence(id, owner.id, false)
  t.mock.timers.setTime(start + 4998)
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), true)
  t.mock.timers.setTime(start + 4999)
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), false)
})

test('无人房间停止自动切歌和音源请求，并持久化离线时的播放进度', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t)
  rooms.presence(id, owner.id, true)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  await rooms.add(id, owner, '1')
  await rooms.add(id, owner, '2')
  await rooms.command(id, owner, { type: 'play' })
  t.mock.timers.setTime(start + 1350)
  rooms.presence(id, owner.id, false)
  assert.equal(rooms.get(id).playback.position, 1)
  const before = music.calls.length
  t.mock.timers.setTime(start + 100_000)
  rooms.tick()
  await rooms.drain()
  assert.equal(music.calls.length, before)
  assert.equal(rooms.get(id).playback.playing, false)
  assert.equal(rooms.get(id).playback.position, 1)
  assert.equal(repo.loadRooms()[0].playback.playing, false)
  assert.equal(repo.loadRooms()[0].playback.position, 1)
})

test('房主会话过期后即使有成员在线也回收房间，并保留其他有效房间和会话', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t)
  const { session: guest } = repo.createSession()
  rooms.join(id, guest, '朋友')
  rooms.presence(id, guest.id, true)
  const other = rooms.create(guest, '有效房间', '朋友')
  await rooms.connectAccount(id, owner, await music.account('demo'))
  await rooms.add(id, owner, '1')
  await rooms.command(id, owner, { type: 'play' })
  rooms.chat(id, owner, '过期房间聊天')
  repo.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(start + 50, owner.id)
  const closed: string[] = []
  rooms.onClose = (roomId) => closed.push(roomId)
  t.mock.timers.setTime(start + 50)
  await rooms.cleanup()
  assert.equal(rooms.rooms.has(id), false)
  assert.equal(cache(rooms).size, 0)
  assert.equal(repo.credential(id), null)
  assert.deepEqual(repo.messages(id), [])
  assert.equal(repo.isMember(id, guest.id), false)
  assert.equal(repo.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(owner.id), undefined)
  assert.equal(repo.hasActiveSession(guest.id), true)
  assert.equal(rooms.rooms.has(other.id), true)
  assert.deepEqual(closed, [id])
})

test('重建服务保留空房截止时间，启动时清除过期空房和失去房主的房间', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t, { idleTtlMs: 1000 })
  t.mock.timers.setTime(start + 700)
  const reopened = new RoomService(repo, music, { idleTtlMs: 1000 })
  assert.equal(reopened.get(id).lastActiveAt, start)
  const orphan = rooms.create(owner, '失去房主', '房主')
  const { session: absentOwner } = repo.createSession()
  const orphanDocument = rooms.get(orphan.id)
  orphanDocument.ownerSessionId = absentOwner.id
  repo.saveRoom(orphanDocument)
  repo.db.prepare('DELETE FROM sessions WHERE id = ?').run(absentOwner.id)
  t.mock.timers.setTime(start + 1000)
  const expired = new RoomService(repo, music, { idleTtlMs: 1000 })
  assert.equal(expired.rooms.size, 0)
  assert.equal(repo.loadRooms().length, 0)
})

test('旧数据库缺少活动时间时给予一次宽限，重复重建服务不会无限续期', async (t) => {
  const { repo, music, rooms, id } = setup(t, { idleTtlMs: 1000 })
  const legacy = rooms.get(id)
  delete legacy.lastActiveAt
  legacy.createdAt = start - 10 * day
  repo.saveRoom(legacy)
  const migrated = new RoomService(repo, music, { idleTtlMs: 1000 })
  assert.equal(migrated.get(id).lastActiveAt, start)
  t.mock.timers.setTime(start + 999)
  assert.equal(new RoomService(repo, music, { idleTtlMs: 1000 }).rooms.has(id), true)
  t.mock.timers.setTime(start + 1000)
  assert.equal(new RoomService(repo, music, { idleTtlMs: 1000 }).rooms.has(id), false)
})

test('反复换入 205 首歌曲并移除旧歌，缓存只保留当前队列内容', async (t) => {
  const { music, rooms, owner, id } = setup(t)
  rooms.presence(id, owner.id, true)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  let previous: string | undefined
  for (let number = 1; number <= 205; number++) {
    const state = await rooms.add(id, owner, String(number))
    const selected = state.queue.find((item) => item.track.id === String(number))!.id
    await rooms.command(id, owner, { type: 'select', queueId: selected })
    if (previous) await rooms.remove(id, owner, previous)
    previous = selected
  }
  assert.equal(rooms.get(id).queue.length, 1)
  assert.equal(cache(rooms).size, 1)
  assert.equal(cache(rooms).has(`${id}:205`), true)
  await rooms.close(id, owner)
  assert.equal(cache(rooms).size, 0)
})

test('播放地址缓存上限覆盖多个房间，淘汰最近最少使用条目并主动清理过期条目', async (t) => {
  const { music, rooms, owner, id } = setup(t, { maxStreams: 2 })
  const second = rooms.create(owner, '另一个房间', '房主')
  for (const roomId of [id, second.id]) {
    rooms.presence(roomId, owner.id, true)
    await rooms.connectAccount(roomId, owner, await music.account('demo'))
    await rooms.add(roomId, owner, '1')
    await rooms.command(roomId, owner, { type: 'play' })
  }
  await rooms.stream(id, owner, rooms.get(id).playback.queueId!)
  const added = await rooms.add(id, owner, '2')
  await rooms.command(id, owner, { type: 'select', queueId: added.queue[1].id })
  assert.equal(cache(rooms).size, 2)
  assert.equal(cache(rooms).has(`${second.id}:1`), false)
  assert.equal(cache(rooms).has(`${id}:1`), true)
  const before = music.calls.length
  await rooms.stream(second.id, owner, rooms.get(second.id).playback.queueId!)
  assert.equal(music.calls.length, before + 1)
  assert.equal(cache(rooms).size, 2)
  t.mock.timers.setTime(start + 3600_000)
  await rooms.cleanup()
  assert.equal(cache(rooms).size, 0)
  await rooms.stream(id, owner, rooms.get(id).playback.queueId!)
  assert.equal(music.calls.length, before + 2)
})

test('切歌请求在断线后才返回，即使已经重连也不能恢复播放或覆盖离线进度', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t)
  rooms.presence(id, owner.id, true)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  await rooms.add(id, owner, '1')
  const added = await rooms.add(id, owner, '2')
  await rooms.command(id, owner, { type: 'play' })
  const first = rooms.get(id).playback.queueId
  const blocked = blockNextStream(music)
  const selecting = rooms.command(id, owner, { type: 'select', queueId: added.queue[1].id })
  await blocked.entered
  t.mock.timers.setTime(start + 1350)
  rooms.presence(id, owner.id, false)
  rooms.presence(id, owner.id, true)
  blocked.release()
  await selecting
  assert.equal(rooms.get(id).playback.queueId, first)
  assert.equal(rooms.get(id).playback.playing, false)
  assert.equal(rooms.get(id).playback.position, 1)
  assert.equal(repo.loadRooms()[0].playback.playing, false)
})

test('清理等待音源请求时有人重连，执行删除前重新校验在线状态', async (t) => {
  const { music, rooms, owner, id } = setup(t, { idleTtlMs: 1000 })
  rooms.presence(id, owner.id, true)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  await rooms.add(id, owner, '1')
  const blocked = blockNextStream(music)
  const playing = rooms.command(id, owner, { type: 'play' })
  await blocked.entered
  rooms.presence(id, owner.id, false)
  t.mock.timers.setTime(start + 1000)
  const cleaning = rooms.cleanup()
  rooms.presence(id, owner.id, true)
  blocked.release()
  await Promise.all([playing, cleaning])
  assert.equal(rooms.rooms.has(id), true)
  assert.equal(rooms.get(id).playback.playing, false)
})

test('清理和显式关闭与慢音源请求并发时不会复活房间或留下缓存', async (t) => {
  const { repo, music, rooms, owner, id } = setup(t, { idleTtlMs: 1000 })
  rooms.presence(id, owner.id, true)
  await rooms.connectAccount(id, owner, await music.account('demo'))
  await rooms.add(id, owner, '1')
  const blocked = blockNextStream(music)
  const playing = rooms.command(id, owner, { type: 'play' })
  await blocked.entered
  rooms.presence(id, owner.id, false)
  t.mock.timers.setTime(start + 1000)
  const closed: string[] = []
  rooms.onClose = (roomId) => closed.push(roomId)
  const closing = rooms.close(id, owner)
  const cleaning = rooms.cleanup()
  blocked.release()
  await Promise.all([playing, closing, cleaning])
  await rooms.drain()
  assert.equal(rooms.rooms.size, 0)
  assert.equal(cache(rooms).size, 0)
  assert.equal(repo.loadRooms().length, 0)
  assert.equal(repo.credential(id), null)
  assert.deepEqual(closed, [id])
})
