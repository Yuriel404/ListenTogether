import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Repository } from '../server/repository.js'
import { DemoProvider } from '../server/music.js'
import { RoomService } from '../server/rooms.js'

async function setup(t: TestContext, count = 3) {
  const repo = new Repository(':memory:', randomBytes(32)), provider = new DemoProvider(), rooms = new RoomService(repo, provider)
  t.after(() => repo.close())
  const owner = repo.createSession().session, member = repo.createSession().session
  const room = rooms.create(owner, '播放方式测试', '房主')
  rooms.join(room.id, member, '成员')
  await rooms.connectAccount(room.id, owner, await provider.account('demo'))
  for (let i = 1; i <= count; i++) await rooms.add(room.id, member, String(i))
  return { repo, rooms, roomId: room.id, owner, member }
}

async function finish(rooms: RoomService, roomId: string) {
  const room = rooms.get(roomId), item = room.queue.find((item) => item.id === room.playback.queueId)!
  room.playback.position = item.track.duration / 1000
  room.playback.updatedAt = Date.now() - 1
  rooms.tick()
  await new Promise<void>((done) => setImmediate(done))
  return rooms.snapshot(roomId)
}

test('顺序播放自动进入下一首，列表末尾暂停', async (t) => {
  const { rooms, roomId, owner } = await setup(t)
  const queue = rooms.snapshot(roomId).queue
  await rooms.command(roomId, owner, { type: 'play' })
  assert.equal((await finish(rooms, roomId)).playback.queueId, queue[1].id)
  assert.equal((await finish(rooms, roomId)).playback.queueId, queue[2].id)
  const ended = await finish(rooms, roomId)
  assert.equal(ended.playback.queueId, queue[2].id)
  assert.equal(ended.playback.playing, false)
})

test('列表循环在最后一首结束后回到第一首，单首列表也会继续播放', async (t) => {
  for (const count of [1, 3]) {
    const { rooms, roomId, member } = await setup(t, count)
    const queue = rooms.snapshot(roomId).queue
    await rooms.command(roomId, member, { type: 'mode', mode: 'loop' })
    await rooms.command(roomId, member, { type: 'select', queueId: queue.at(-1)!.id })
    const next = await finish(rooms, roomId)
    assert.equal(next.playbackMode, 'loop')
    assert.equal(next.playback.queueId, queue[0].id)
    assert.equal(next.playback.playing, true)
    assert.equal(next.playback.position, 0)
  }
})

test('随机播放每轮覆盖所有歌曲，跨轮不连续重复，上一首沿随机顺序返回', async (t) => {
  const { rooms, roomId, owner, member } = await setup(t)
  await rooms.command(roomId, member, { type: 'mode', mode: 'random' })
  const first = await rooms.command(roomId, owner, { type: 'play' })
  const round = [first.playback.queueId]
  for (let i = 1; i < first.queue.length; i++) round.push((await finish(rooms, roomId)).playback.queueId)
  assert.deepEqual(new Set(round), new Set(first.queue.map((item) => item.id)))
  const next = await finish(rooms, roomId)
  assert.notEqual(next.playback.queueId, round.at(-1))
  const previous = await rooms.command(roomId, member, { type: 'previous' })
  assert.equal(previous.playback.queueId, round.at(-1))
  const resumed = await rooms.command(roomId, member, { type: 'next' })
  assert.equal(resumed.playback.queueId, next.playback.queueId)
  const secondRound = [resumed.playback.queueId]
  for (let i = 1; i < first.queue.length; i++) secondRound.push((await finish(rooms, roomId)).playback.queueId)
  assert.deepEqual(new Set(secondRound), new Set(first.queue.map((item) => item.id)))
  const prior = await rooms.command(roomId, member, { type: 'previous' })
  assert.equal(prior.playback.queueId, secondRound.at(-2))
})

test('随机播放只有一首歌时继续播放；增删队列后不会播放已移除的歌曲', async (t) => {
  const { rooms, roomId, owner, member } = await setup(t, 1)
  await rooms.command(roomId, member, { type: 'mode', mode: 'random' })
  const initial = await rooms.command(roomId, owner, { type: 'play' })
  const repeat = await finish(rooms, roomId)
  assert.equal(repeat.playback.queueId, initial.playback.queueId)
  assert.equal(repeat.playback.playing, true)
  for (const id of ['2', '3']) await rooms.add(roomId, member, id)
  const removed = rooms.snapshot(roomId).queue[1].id
  await rooms.remove(roomId, owner, removed)
  const next = await finish(rooms, roomId)
  assert.notEqual(next.playback.queueId, initial.playback.queueId)
  assert.ok(next.queue.some((item) => item.id === next.playback.queueId))
  assert.equal(next.queue.some((item) => item.id === removed), false)
})

test('修改播放方式不暂停、不跳转，旧房间默认顺序播放', async (t) => {
  const { repo, rooms, roomId, owner, member } = await setup(t)
  const playing = await rooms.command(roomId, owner, { type: 'play' })
  const changed = await rooms.command(roomId, member, { type: 'mode', mode: 'random' })
  assert.deepEqual(changed.playback, playing.playback)
  assert.equal(changed.playbackMode, 'random')
  const legacy = { ...rooms.get(roomId) } as Partial<ReturnType<RoomService['get']>>
  delete legacy.playbackMode
  repo.db.prepare('UPDATE rooms SET document = ? WHERE id = ?').run(JSON.stringify(legacy), roomId)
  const recovered = new RoomService(repo, new DemoProvider())
  assert.equal(recovered.snapshot(roomId).playbackMode, 'sequence')
})
