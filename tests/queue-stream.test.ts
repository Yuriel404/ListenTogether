import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { StreamInfo, Track } from '../shared/types.js'
import { MAX_QUEUE_TRACKS } from '../shared/types.js'
import { Repository } from '../server/repository.js'
import { DemoProvider, demoTracks } from '../server/music.js'
import { RoomService } from '../server/rooms.js'

function gate() {
  let release!: () => void, enter!: () => void
  const started = new Promise<void>((resolve) => { enter = resolve })
  const waiting = new Promise<void>((resolve) => { release = resolve })
  return { started, release, wait: async () => { enter(); await waiting } }
}

class QueueMusic extends DemoProvider {
  tracks: Track[] = []
  beforePlaylist?: () => Promise<void>
  beforeStream?: () => Promise<void>
  streamCalls = 0
  async playlist() { const tracks = [...this.tracks]; await this.beforePlaylist?.(); return tracks }
  async track(id: string) { return { ...demoTracks[0], id } }
  async stream(track: Track, cookie: string, roomId: string): Promise<StreamInfo> {
    this.streamCalls++
    await this.beforeStream?.()
    return { url: `https://audio.example/${roomId}/${track.id}?account=${cookie}`, expiresAt: Date.now() + 3600_000 }
  }
}

function setup(t: TestContext) {
  const repo = new Repository(':memory:', randomBytes(32))
  const music = new QueueMusic(), rooms = new RoomService(repo, music)
  t.after(async () => { await rooms.drain(); repo.close() })
  const { session: owner } = repo.createSession(), { session: guest } = repo.createSession()
  const { id } = rooms.create(owner, '队列测试', '房主')
  rooms.join(id, guest, '朋友')
  rooms.presence(id, owner.id, true)
  return { repo, music, rooms, owner, guest, id }
}

function cache(rooms: RoomService): Map<string, StreamInfo> {
  return (rooms as unknown as { streams: Map<string, StreamInfo> }).streams
}

async function playable(t: TestContext) {
  const context = setup(t)
  const { rooms, music, owner, id } = context
  await rooms.connectAccount(id, owner, await music.account('first'))
  await rooms.add(id, owner, '1')
  await rooms.add(id, owner, '2')
  const state = await rooms.command(id, owner, { type: 'play' })
  return { ...context, queueId: state.playback.queueId! }
}

test('单次导入 450 首，按歌曲 ID 去重并保留歌单顺序', async (t) => {
  const { music, rooms, guest, id } = setup(t)
  music.tracks = Array.from({ length: 450 }, (_, index) => ({ ...demoTracks[0], id: String(index + 1) }))
  music.tracks.splice(50, 0, music.tracks[0])
  const result = await rooms.add(id, guest, 'playlist', true)
  assert.equal(result.queue.length, 450)
  assert.deepEqual(result.queue.map((item) => item.track.id), Array.from({ length: 450 }, (_, index) => String(index + 1)))
  assert.equal(result.queue[449].addedBy, '朋友')
})

test('队列可容纳 1000 首；并发导入在提交时检查容量，失败不部分写入', async (t) => {
  const { music, rooms, owner, id } = setup(t)
  music.tracks = Array.from({ length: MAX_QUEUE_TRACKS - 1 }, (_, index) => ({ ...demoTracks[0], id: String(index + 1) }))
  await rooms.add(id, owner, 'playlist', true)
  const results = await Promise.allSettled([rooms.add(id, owner, 'last-a'), rooms.add(id, owner, 'last-b')])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(rooms.snapshot(id).queue.length, MAX_QUEUE_TRACKS)
  await assert.rejects(rooms.add(id, owner, 'overflow'), /1000/)
  assert.equal(rooms.snapshot(id).queue.length, MAX_QUEUE_TRACKS)
})

test('仅房主可清空，清空会停止播放并持久化，保留账号、成员与聊天', async (t) => {
  const { repo, rooms, owner, guest, id } = await playable(t)
  rooms.chat(id, guest, '保留聊天')
  await rooms.command(id, guest, { type: 'mode', mode: 'random' })
  await rooms.command(id, owner, { type: 'seek', position: 20 })
  const before = rooms.snapshot(id)
  assert.equal(cache(rooms).size, 1)
  await assert.rejects(rooms.clearQueue(id, guest), /只有房主/)
  assert.equal(rooms.snapshot(id).queue.length, 2)
  const cleared = await rooms.clearQueue(id, owner)
  assert.deepEqual(cleared.queue, [])
  assert.equal(cleared.playback.queueId, null)
  assert.equal(cleared.playback.playing, false)
  assert.equal(cleared.playback.position, 0)
  assert.ok(cleared.playback.revision > before.playback.revision)
  assert.equal(cleared.playbackMode, 'random')
  assert.deepEqual(cleared.account, before.account)
  assert.deepEqual(cleared.members, before.members)
  assert.equal(repo.messages(id)[0].text, '保留聊天')
  assert.ok(repo.credential(id))
  assert.equal(cache(rooms).size, 0)
  assert.deepEqual(repo.loadRooms()[0].queue, [])
  assert.equal(repo.loadRooms()[0].playback.queueId, null)
  await rooms.add(id, guest, '3')
  assert.equal(rooms.snapshot(id).queue.length, 1)
})

test('清空期间尚未完成的歌单导入不会重新填充队列', async (t) => {
  const { music, rooms, owner, guest, id } = setup(t)
  const blocked = gate()
  music.tracks = [...demoTracks]
  music.beforePlaylist = blocked.wait
  const rejected = assert.rejects(rooms.add(id, guest, 'playlist', true), /歌单已清空/)
  await blocked.started
  try {
    await rooms.clearQueue(id, owner)
    await rooms.add(id, owner, 'fresh')
  } finally { blocked.release() }
  await rejected
  assert.deepEqual(rooms.snapshot(id).queue.map((item) => item.track.id), ['fresh'])
})

test('三个并发成员请求共用一次上游读取，暂停无需等待音源返回', async (t) => {
  const { music, rooms, owner, guest, id, queueId } = await playable(t)
  const blocked = gate()
  music.beforeStream = blocked.wait
  const reads = Promise.all(Array.from({ length: 3 }, () => rooms.stream(id, guest, queueId, true)))
  await blocked.started
  try {
    const paused = await Promise.race([
      rooms.command(id, owner, { type: 'pause' }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('暂停被慢请求阻塞')), 1000); timer.unref() }),
    ])
    assert.equal(paused.playback.playing, false)
    assert.equal(music.streamCalls, 2) // 首次播放一次，本次三个请求合并为一次。
  } finally { blocked.release() }
  assert.equal((await reads).length, 3)
})

for (const action of ['clear', 'disconnect', 'close'] as const) {
  test(`慢音源读取期间 ${action} 立即生效，迟到结果不能重新填入缓存`, async (t) => {
    const { music, rooms, owner, guest, id, queueId } = await playable(t)
    const blocked = gate()
    music.beforeStream = blocked.wait
    const rejected = assert.rejects(rooms.stream(id, guest, queueId, true), /已更新|已关闭/)
    await blocked.started
    try {
      const operation = action === 'clear' ? rooms.clearQueue(id, owner) : action === 'disconnect' ? rooms.disconnectAccount(id, owner) : rooms.close(id, owner)
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`${action} 被慢请求阻塞`)), 1000); timer.unref() }),
      ])
      assert.equal(cache(rooms).size, 0)
    } finally { blocked.release() }
    await rejected
    assert.equal(cache(rooms).size, 0)
  })
}

test('账号切换后的新请求独立执行，旧账号迟到结果不能覆盖新缓存', async (t) => {
  const { music, rooms, owner, guest, id, queueId } = await playable(t)
  const blocked = gate()
  music.beforeStream = blocked.wait
  const rejected = assert.rejects(rooms.stream(id, guest, queueId, true), /已更新/)
  await blocked.started
  try {
    await rooms.connectAccount(id, owner, { cookie: 'second', nickname: '新账号', avatarUrl: '', vipType: 0 })
    music.beforeStream = undefined
    await rooms.command(id, owner, { type: 'play' })
    assert.match((await rooms.stream(id, guest, queueId)).url, /account=second/)
  } finally { blocked.release() }
  await rejected
  assert.match(cache(rooms).get(`${id}:1`)!.url, /account=second/)
})

test('解析已完成但读取尚未返回时解绑，最终响应也不能返回旧账号地址', async (t) => {
  const { music, rooms, owner, guest, id, queueId } = await playable(t)
  let release!: (stream: StreamInfo) => void
  music.stream = () => new Promise<StreamInfo>((resolve) => { release = resolve })
  const rejected = assert.rejects(rooms.stream(id, guest, queueId, true), /已更新/)
  // 同一调用栈排入音源结果和解绑：覆盖解析校验与外层读取返回之间的微任务窗口。
  release({ url: 'https://audio.example/old-account', expiresAt: Date.now() + 300_000 })
  await rooms.disconnectAccount(id, owner)
  await rejected
  assert.equal(rooms.snapshot(id).account.connected, false)
  assert.equal(cache(rooms).size, 0)
})
