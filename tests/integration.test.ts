import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import type { AddressInfo } from 'node:net'
import type { Ack, RoomSnapshot, SessionInfo, Track } from '../shared/types.js'
import { createApplication } from '../server/app.js'
import { AppError } from '../server/errors.js'
import { DemoProvider, demoTracks, type MusicProvider } from '../server/music.js'
import { Repository } from '../server/repository.js'

class FakeMusic implements MusicProvider {
  readonly mode = 'netease' as const
  readonly demo = new DemoProvider()
  qrCalls = 0
  streamCalls: { roomId: string; cookie: string; trackId: string }[] = []
  denyId = ''
  async qr() { this.qrCalls++; return { key: 'private-upstream-key', image: 'data:image/png;base64,test' } }
  async checkQr(key: string) { assert.equal(key, 'private-upstream-key'); return { status: 803, account: await this.account('MUSIC_U=private-test-cookie') } }
  async account(cookie: string) { return { cookie, nickname: '测试房主', avatarUrl: '', vipType: 10 } }
  search(query: string, offset: number, cookie: string | null) { return this.demo.search(query, offset, cookie) }
  track(input: string, cookie: string | null) { return this.demo.track(input, cookie) }
  playlist(input: string, cookie: string | null) { return this.demo.playlist(input, cookie) }
  lyric(id: string, cookie: string | null) { return this.demo.lyric(id, cookie) }
  async stream(track: Track, cookie: string, roomId: string) {
    this.streamCalls.push({ roomId, cookie, trackId: track.id })
    if (track.id === this.denyId) throw new AppError(403, '账号只能试听此曲')
    return { url: `https://audio.example/${roomId}/${track.id}.mp3?v=${this.streamCalls.length}`, expiresAt: Date.now() + 300000, bitrate: 320000 }
  }
}

const provider = new FakeMusic()
const repo = new Repository(':memory:', randomBytes(32))
const server = createApplication({ port: 0, host: '127.0.0.1', dataDir: '.', credentialKey: randomBytes(32), sessionSecret: randomBytes(32).toString('hex'), publicOrigins: [], secureCookie: false, trustProxy: false, provider: 'netease' }, { repository: repo, provider })
let base: string
const sockets: Socket[] = []
interface User { cookie: string; info: SessionInfo }

before(async () => {
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`
})
after(async () => { for (const socket of sockets) socket.disconnect(); await server.close() })

async function user(): Promise<User> {
  const response = await fetch(`${base}/api/session`)
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')!
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i)
  return { cookie: cookie.split(';')[0], info: await response.json() as SessionInfo }
}
async function call(who: User, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { cookie: who.cookie, 'x-csrf-token': who.info.csrfToken, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() as any }
}
async function create(who: User, password?: string): Promise<RoomSnapshot> {
  const result = await call(who, '/rooms', 'POST', { name: '测试听歌室', nickname: '房主', password })
  assert.equal(result.status, 201)
  return result.body
}
async function connect(who: User, roomId: string): Promise<Socket> {
  const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Cookie: who.cookie }, auth: { roomId, csrfToken: who.info.csrfToken } })
  sockets.push(socket)
  await new Promise<void>((done, fail) => { socket.once('connect', done); socket.once('connect_error', fail) })
  return socket
}
async function command(socket: Socket, payload: unknown): Promise<Ack<RoomSnapshot>> {
  return new Promise((done, fail) => socket.timeout(5000).emit('player:command', payload, (error: Error | null, ack: Ack<RoomSnapshot>) => error ? fail(error) : done(ack)))
}

test('创建持久房间，密码加入；非成员不能读取队列、聊天或播放地址', async () => {
  const owner = await user(), guest = await user()
  const room = await create(owner, '123456')
  assert.equal((await call(guest, `/rooms/${room.id}`)).status, 403)
  assert.equal((await call(guest, `/rooms/${room.id}/messages`)).status, 403)
  assert.equal((await call(guest, `/rooms/${room.id}/stream?queueId=${randomUUID()}`)).status, 403)
  assert.equal((await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '朋友', password: 'wrong' })).status, 403)
  const joined = await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '朋友', password: '123456' })
  assert.equal(joined.status, 200)
  assert.equal(joined.body.members.length, 2)
  assert.equal(repo.loadRooms().some((r) => r.id === room.id), true)
  assert.ok(!JSON.stringify(joined.body).includes('passwordHash'))
  assert.ok(!JSON.stringify(joined.body).includes('ownerSessionId'))
})

test('REST 写入校验 CSRF 与来源；拒绝恶意来源的 WebSocket 握手', async () => {
  const owner = await user()
  assert.equal((await call(owner, '/rooms', 'POST', { name: 'test', nickname: 'test' }, { 'x-csrf-token': 'bad' })).status, 403)
  assert.equal((await call(owner, '/rooms', 'POST', { name: 'test', nickname: 'test' }, { Origin: 'https://evil.example' })).status, 403)
  const room = await create(owner)
  const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Cookie: owner.cookie, Origin: 'https://evil.example' }, auth: { roomId: room.id, csrfToken: owner.info.csrfToken } })
  sockets.push(socket)
  await new Promise<void>((done, fail) => { socket.once('connect_error', () => done()); socket.once('connect', () => fail(new Error('不应允许恶意来源连接'))) })
})

test('仅房主能扫码绑定账号；挑战绑定房间；API 与广播绝不返回凭据', async () => {
  const owner = await user(), guest = await user(), room = await create(owner)
  await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '朋友' })
  const before = provider.qrCalls
  assert.equal((await call(guest, `/rooms/${room.id}/account/qr`, 'POST', {})).status, 403)
  assert.equal(provider.qrCalls, before)
  const generated = await call(owner, `/rooms/${room.id}/account/qr`, 'POST', {})
  assert.equal(generated.status, 200)
  assert.ok(!JSON.stringify(generated.body).includes('private-upstream-key'))
  assert.equal((await call(owner, `/rooms/${room.id}/account/qr/${randomUUID()}/check`, 'POST', {})).body.status, 800)
  assert.equal((await call(guest, `/rooms/${room.id}/account/qr/${generated.body.requestId}/check`, 'POST', {})).status, 403)
  const checked = await call(owner, `/rooms/${room.id}/account/qr/${generated.body.requestId}/check`, 'POST', {})
  assert.deepEqual(checked.body, { status: 803 })
  const publicRoom = (await call(guest, `/rooms/${room.id}`)).body
  assert.equal(publicRoom.account.connected, true)
  assert.ok(!JSON.stringify(publicRoom).includes('private-test-cookie'))
  const encrypted = repo.db.prepare('SELECT encrypted FROM credentials WHERE room_id = ?').get(room.id)!
  assert.ok(!String(encrypted.encrypted).includes('private-test-cookie'))
})

test('成员可点歌、拖动进度和切歌，操作广播同步；播放暂停和管理仍检查房主身份', async () => {
  const owner = await user(), guest = await user(), room = await create(owner)
  await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '朋友' })
  await call(owner, `/rooms/${room.id}/account/cookie`, 'POST', { cookie: 'MUSIC_U=room-owner-cookie' })
  const added = await call(guest, `/rooms/${room.id}/queue`, 'POST', { input: '1' })
  assert.equal(added.status, 200); assert.equal(added.body.queue[0].addedBy, '朋友')
  assert.equal((await call(guest, `/rooms/${room.id}/queue`, 'POST', { input: '1' })).status, 400)
  const second = await call(guest, `/rooms/${room.id}/queue`, 'POST', { input: '2' })
  assert.equal((await call(guest, `/rooms/${room.id}/queue/${second.body.queue[1].id}`, 'DELETE')).status, 403)
  const hostSocket = await connect(owner, room.id), guestSocket = await connect(guest, room.id)
  const rejected = await command(guestSocket, { type: 'play' })
  assert.equal(rejected.ok, false)
  const broadcast = new Promise<RoomSnapshot>((done) => guestSocket.once('room:state', done))
  const played = await command(hostSocket, { type: 'play' })
  assert.equal(played.ok, true)
  const state = await broadcast
  assert.equal(state.playback.playing, true)
  assert.equal(state.playback.queueId, added.body.queue[0].id)
  assert.ok(state.playback.updatedAt > state.serverTime)
  assert.equal((await call(guest, `/rooms/${room.id}/stream?queueId=${state.playback.queueId}`)).status, 200)
  assert.equal(provider.streamCalls.find((c) => c.roomId === room.id)?.cookie, 'MUSIC_U=room-owner-cookie')
  const seekBroadcast = new Promise<RoomSnapshot>((done) => hostSocket.once('room:state', done))
  const seeked = await command(guestSocket, { type: 'seek', position: 25 })
  assert.ok(seeked.ok && seeked.data.playback.position === 25)
  assert.equal((await seekBroadcast).playback.position, 25)
  const late = await user()
  const lateState = await call(late, `/rooms/${room.id}/join`, 'POST', { nickname: '后来的人' })
  assert.equal(lateState.body.playback.position, 25)
  const next = await command(guestSocket, { type: 'next' })
  assert.ok(next.ok && next.data.playback.queueId === second.body.queue[1].id)
  const previous = await command(guestSocket, { type: 'previous' })
  assert.ok(previous.ok && previous.data.playback.queueId === added.body.queue[0].id)
  const selected = await command(guestSocket, { type: 'select', queueId: second.body.queue[1].id })
  assert.ok(selected.ok && selected.data.playback.queueId === second.body.queue[1].id)
  const changes = await Promise.all([command(hostSocket, { type: 'seek', position: 5 }), command(guestSocket, { type: 'seek', position: 15 })])
  assert.ok(changes[0].ok && changes[1].ok)
  if (changes[0].ok && changes[1].ok) {
    assert.equal(Math.abs(changes[0].data.playback.revision - changes[1].data.playback.revision), 1)
    const latest = changes.sort((a, b) => a.ok && b.ok ? b.data.playback.revision - a.data.playback.revision : 0)[0]
    assert.ok(latest.ok && (await call(owner, `/rooms/${room.id}`)).body.playback.position === latest.data.playback.position)
  }
  assert.equal((await command(guestSocket, { type: 'pause' })).ok, false)
  const paused = await command(hostSocket, { type: 'pause' })
  assert.ok(paused.ok && !paused.data.playback.playing)
})

test('成员切换播放方式会广播给所有人，保留当前播放基准，后加入成员也同步', async () => {
  const owner = await user(), guest = await user(), room = await create(owner)
  await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '播放方式成员' })
  const host = await connect(owner, room.id), peer = await connect(guest, room.id)
  const broadcast = new Promise<RoomSnapshot>((done) => {
    const changed = (state: RoomSnapshot) => { if (state.playbackMode === 'loop') { host.off('room:state', changed); done(state) } }
    host.on('room:state', changed)
  })
  const changed = await command(peer, { type: 'mode', mode: 'loop' })
  assert.ok(changed.ok)
  if (!changed.ok) return
  assert.equal(changed.data.playbackMode, 'loop')
  assert.deepEqual(changed.data.playback, room.playback)
  assert.equal((await broadcast).playbackMode, 'loop')
  const late = await user()
  assert.equal((await call(late, `/rooms/${room.id}/join`, 'POST', { nickname: '后来加入' })).body.playbackMode, 'loop')
  for (const payload of [{ type: 'mode' }, { type: 'mode', mode: 'invalid' }]) assert.equal((await command(peer, payload)).ok, false)
  assert.equal((await call(guest, `/rooms/${room.id}`)).body.playbackMode, 'loop')
})

test('未登录网易云的成员使用房主解析的同一 CDN 链接，刷新和账号变更使链接缓存失效', async () => {
  const owner = await user(), guest = await user(), outsider = await user(), room = await create(owner)
  await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '无需网易云登录' })
  await call(owner, `/rooms/${room.id}/account/cookie`, 'POST', { cookie: 'MUSIC_U=shared-link-owner' })
  await call(owner, `/rooms/${room.id}/queue`, 'POST', { input: '1' })
  const host = await connect(owner, room.id)
  const played = await command(host, { type: 'play' })
  assert.ok(played.ok)
  if (!played.ok) return
  const queueId = played.data.playback.queueId
  const [ownStream, peerStream] = await Promise.all([
    call(owner, `/rooms/${room.id}/stream?queueId=${queueId}`), call(guest, `/rooms/${room.id}/stream?queueId=${queueId}`),
  ])
  assert.equal(ownStream.status, 200); assert.equal(peerStream.status, 200)
  assert.equal(ownStream.body.url, peerStream.body.url)
  assert.equal(peerStream.body.bitrate, 320000)
  assert.equal(new URL(peerStream.body.url).hostname, 'audio.example')
  assert.equal(new URL(peerStream.body.url).pathname, `/${room.id}/1.mp3`)
  assert.ok(!JSON.stringify(peerStream.body).includes('MUSIC_U'))
  assert.equal((await call(outsider, `/rooms/${room.id}/stream?queueId=${queueId}`)).status, 403)
  assert.equal((await fetch(`${base}/api/rooms/${room.id}/stream?queueId=${queueId}`)).status, 401)
  assert.equal((await call(guest, `/rooms/${room.id}/audio/${queueId}`)).status, 404)
  const roomCalls = () => provider.streamCalls.filter((call) => call.roomId === room.id)
  assert.deepEqual(roomCalls(), [{ roomId: room.id, cookie: 'MUSIC_U=shared-link-owner', trackId: '1' }])
  const refreshed = await call(guest, `/rooms/${room.id}/stream?queueId=${queueId}&refresh=1`)
  assert.equal(refreshed.status, 200)
  assert.notEqual(refreshed.body.url, peerStream.body.url)
  assert.equal(roomCalls().length, 2)
  assert.equal((await call(owner, `/rooms/${room.id}/stream?queueId=${queueId}`)).body.url, refreshed.body.url)
  await call(owner, `/rooms/${room.id}/account`, 'DELETE')
  assert.equal((await call(guest, `/rooms/${room.id}/stream?queueId=${queueId}`)).status, 400)
  await call(owner, `/rooms/${room.id}/account/cookie`, 'POST', { cookie: 'MUSIC_U=new-link-owner' })
  assert.equal((await command(host, { type: 'play' })).ok, true)
  const newStream = await call(guest, `/rooms/${room.id}/stream?queueId=${queueId}`)
  assert.equal(newStream.status, 200)
  assert.notEqual(newStream.body.url, refreshed.body.url)
  assert.equal(roomCalls().length, 3)
  assert.equal(roomCalls()[2].cookie, 'MUSIC_U=new-link-owner')
  await call(owner, `/rooms/${room.id}`, 'DELETE')
  assert.equal((await call(guest, `/rooms/${room.id}/stream?queueId=${queueId}`)).status, 404)
})

test('Cookie 和音源缓存严格按房间隔离，只有当前歌曲可以获取播放地址', async () => {
  const owner = await user(), roomA = await create(owner), roomB = await create(owner)
  await call(owner, `/rooms/${roomA.id}/account/cookie`, 'POST', { cookie: 'MUSIC_U=only-room-a' })
  const a = await call(owner, `/rooms/${roomA.id}/queue`, 'POST', { input: '1' })
  const b = await call(owner, `/rooms/${roomB.id}/queue`, 'POST', { input: '1' })
  const aSocket = await connect(owner, roomA.id), bSocket = await connect(owner, roomB.id)
  assert.equal((await command(aSocket, { type: 'play' })).ok, true)
  const failed = await command(bSocket, { type: 'play' })
  assert.equal(failed.ok, false)
  assert.ok(!provider.streamCalls.some((c) => c.roomId === roomB.id))
  assert.equal((await call(owner, `/rooms/${roomB.id}/stream?queueId=${b.body.queue[0].id}`)).status, 409)
  await call(owner, `/rooms/${roomA.id}/queue`, 'POST', { input: '2' })
  const wrong = (await call(owner, `/rooms/${roomA.id}`)).body.queue[1].id
  assert.equal((await call(owner, `/rooms/${roomA.id}/stream?queueId=${wrong}`)).status, 409)
  assert.equal((await call(owner, `/rooms/${roomA.id}/stream?queueId=${a.body.queue[0].id}`)).status, 200)
})

test('解析失败不切换当前歌曲；并发点歌不丢失队列；断开账号使成员停止播放', async () => {
  const owner = await user(), room = await create(owner)
  await call(owner, `/rooms/${room.id}/account/cookie`, 'POST', { cookie: 'MUSIC_U=failure-test' })
  await Promise.all(['1', '2', '3'].map((input) => call(owner, `/rooms/${room.id}/queue`, 'POST', { input })))
  const snapshot = (await call(owner, `/rooms/${room.id}`)).body as RoomSnapshot
  assert.equal(snapshot.queue.length, 3)
  const socket = await connect(owner, room.id)
  await command(socket, { type: 'select', queueId: snapshot.queue.find((q) => q.track.id === '1')!.id })
  provider.denyId = '2'
  const denied = await command(socket, { type: 'select', queueId: snapshot.queue.find((q) => q.track.id === '2')!.id })
  assert.equal(denied.ok, false)
  assert.equal((await call(owner, `/rooms/${room.id}`)).body.playback.queueId, snapshot.queue.find((q) => q.track.id === '1')!.id)
  provider.denyId = ''
  const disconnected = await call(owner, `/rooms/${room.id}/account`, 'DELETE')
  assert.equal(disconnected.body.playback.playing, false)
  assert.equal(disconnected.body.account.connected, false)
  assert.equal(repo.credential(room.id), null)
  assert.equal((await call(owner, `/rooms/${room.id}/stream?queueId=${snapshot.queue.find((q) => q.track.id === '1')!.id}`)).status, 400)
})

test('聊天消息广播并持久化，房主关闭房间会删除凭据和成员记录', async () => {
  const owner = await user(), guest = await user(), room = await create(owner)
  await call(guest, `/rooms/${room.id}/join`, 'POST', { nickname: '聊天朋友' })
  await call(owner, `/rooms/${room.id}/account/cookie`, 'POST', { cookie: 'MUSIC_U=closing-test' })
  const host = await connect(owner, room.id), peer = await connect(guest, room.id)
  const received = new Promise<any>((done) => host.once('chat:message', done))
  const ack = await new Promise<Ack<unknown>>((done) => peer.emit('chat:send', { text: '<script>plain text</script>' }, done))
  assert.equal(ack.ok, true)
  const message = await received
  assert.equal(message.nickname, '聊天朋友')
  assert.equal((await call(owner, `/rooms/${room.id}/messages`)).body[0].text, '<script>plain text</script>')
  assert.equal((await call(guest, `/rooms/${room.id}`, 'DELETE')).status, 403)
  const closed = new Promise<void>((done) => peer.once('room:closed', done))
  assert.equal((await call(owner, `/rooms/${room.id}`, 'DELETE')).status, 200)
  await closed
  assert.equal(repo.credential(room.id), null)
  assert.equal(repo.isMember(room.id, repo.findSession(guest.cookie.split('=')[1])!.id), false)
  assert.equal((await call(owner, `/rooms/${room.id}`)).status, 404)
})
