import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApplication } from '../server/app.js'
import { DemoProvider, type AccountInfo, type MusicProvider } from '../server/music.js'
import { Repository } from '../server/repository.js'
import type { RoomSnapshot, SessionInfo, StreamInfo, Track } from '../shared/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function account(cookie: string): AccountInfo {
  return { cookie, nickname: cookie, avatarUrl: '', vipType: 0 }
}

class ControlledMusic implements MusicProvider {
  readonly mode = 'netease' as const
  readonly demo = new DemoProvider()
  qrHandler = async () => ({ key: 'qr-current', image: 'data:image/png;base64,test' })
  accountHandler = async (cookie: string) => account(cookie)
  checkHandler = async (key: string) => ({ status: 803, account: account(`MUSIC_U=${key}`) })
  streamHandler = async (): Promise<StreamInfo> => ({ url: 'https://audio.example/test.mp3', expiresAt: Date.now() + 300_000 })
  qr() { return this.qrHandler() }
  account(cookie: string) { return this.accountHandler(cookie) }
  checkQr(key: string) { return this.checkHandler(key) }
  search(query: string, offset: number, cookie: string | null) { return this.demo.search(query, offset, cookie) }
  track(input: string, cookie: string | null) { return this.demo.track(input, cookie) }
  playlist(input: string, cookie: string | null) { return this.demo.playlist(input, cookie) }
  lyric(id: string, cookie: string | null) { return this.demo.lyric(id, cookie) }
  stream(_track: Track, _cookie: string, _roomId: string) { return this.streamHandler() }
}

async function setup(t: TestContext) {
  const provider = new ControlledMusic()
  const repo = new Repository(':memory:', randomBytes(32))
  const server = createApplication({ port: 0, host: '127.0.0.1', dataDir: '.', credentialKey: randomBytes(32), sessionSecret: randomBytes(32).toString('hex'), publicOrigins: [], secureCookie: false, trustProxy: false, provider: 'netease' }, { repository: repo, provider })
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}/api`
  const sessionResponse = await fetch(`${base}/session`)
  const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]
  const info = await sessionResponse.json() as SessionInfo
  const session = repo.findSession(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)))!
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, 'x-csrf-token': info.csrfToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const created = await call('/rooms', 'POST', { name: '账号并发测试', nickname: '房主' })
  assert.equal(created.status, 201)
  const room = created.body as RoomSnapshot
  const path = `/rooms/${room.id}`
  return { provider, repo, server, session, room, path, call }
}

test('HTTP：解绑成功后，迟到的 Cookie 验证不能重新绑定账号', { timeout: 10_000 }, async (t) => {
  const { provider, repo, room, path, call } = await setup(t)
  const started = deferred<void>(), release = deferred<AccountInfo>()
  provider.accountHandler = () => { started.resolve(); return release.promise }
  const binding = call(`${path}/account/cookie`, 'POST', { cookie: 'MUSIC_U=delayed-cookie' })
  try {
    await started.promise
    const unbound = await call(`${path}/account`, 'DELETE')
    assert.equal(unbound.status, 200)
    assert.equal(unbound.body.account.connected, false)
  } finally { release.resolve(account('MUSIC_U=delayed-cookie')) }
  assert.equal((await binding).status, 409)
  assert.equal((await call(path)).body.account.connected, false)
  assert.equal(repo.credential(room.id), null)
})

test('HTTP：较早请求的二维码迟到时，不能覆盖已经返回的新二维码', { timeout: 10_000 }, async (t) => {
  const { provider, repo, room, path, call } = await setup(t)
  const started = deferred<void>(), release = deferred<{ key: string; image: string }>()
  let calls = 0
  provider.qrHandler = () => {
    if (++calls === 1) { started.resolve(); return release.promise }
    return Promise.resolve({ key: 'qr-new', image: 'data:image/png;base64,new' })
  }
  const older = call(`${path}/account/qr`, 'POST')
  let requestId: string
  try {
    await started.promise
    const newer = await call(`${path}/account/qr`, 'POST')
    assert.equal(newer.status, 200)
    requestId = newer.body.requestId
  } finally { release.resolve({ key: 'qr-old', image: 'data:image/png;base64,old' }) }
  assert.equal((await older).status, 409)
  const checked = await call(`${path}/account/qr/${requestId!}/check`, 'POST')
  assert.deepEqual(checked.body, { status: 803 })
  assert.equal(repo.credential(room.id), 'MUSIC_U=qr-new')
})

test('HTTP：扫码检查响应迟于解绑时，不得恢复已解绑的账号', { timeout: 10_000 }, async (t) => {
  const { provider, repo, room, path, call } = await setup(t)
  const started = deferred<void>(), release = deferred<{ status: number; account: AccountInfo }>()
  provider.checkHandler = () => { started.resolve(); return release.promise }
  const generated = await call(`${path}/account/qr`, 'POST')
  const checking = call(`${path}/account/qr/${generated.body.requestId}/check`, 'POST')
  try {
    await started.promise
    assert.equal((await call(`${path}/account`, 'DELETE')).status, 200)
  } finally { release.resolve({ status: 803, account: account('MUSIC_U=delayed-qr') }) }
  assert.deepEqual((await checking).body, { status: 800 })
  assert.equal(repo.credential(room.id), null)
  assert.equal((await call(path)).body.account.connected, false)
})

test('HTTP：扫码成功等待房间写锁期间发生解绑，不得短暂写入失效的登录凭据', { timeout: 10_000 }, async (t) => {
  const { provider, repo, server, session, room, path, call } = await setup(t)
  assert.equal((await call(`${path}/account/cookie`, 'POST', { cookie: 'MUSIC_U=initial-account' })).status, 200)
  assert.equal((await call(`${path}/queue`, 'POST', { input: '1' })).status, 200)
  const started = deferred<void>(), release = deferred<StreamInfo>()
  provider.streamHandler = () => { started.resolve(); return release.promise }
  const playing = server.rooms.command(room.id, session, { type: 'play' })
  let checking: ReturnType<typeof call> | undefined, disconnecting: ReturnType<typeof call> | undefined
  const boundAccounts: string[] = []
  const onChange = server.rooms.onChange
  server.rooms.onChange = (snapshot) => {
    if (snapshot.account.connected) boundAccounts.push(snapshot.account.nickname || '')
    onChange(snapshot)
  }
  try {
    await started.promise
    const generated = await call(`${path}/account/qr`, 'POST')
    const bindQueued = deferred<void>(), disconnectQueued = deferred<void>()
    const connect = server.rooms.connectAccount.bind(server.rooms)
    server.rooms.connectAccount = (...args) => { const result = connect(...args); bindQueued.resolve(); return result }
    const disconnect = server.rooms.disconnectAccount.bind(server.rooms)
    server.rooms.disconnectAccount = (...args) => { const result = disconnect(...args); disconnectQueued.resolve(); return result }
    checking = call(`${path}/account/qr/${generated.body.requestId}/check`, 'POST')
    await bindQueued.promise
    disconnecting = call(`${path}/account`, 'DELETE')
    await disconnectQueued.promise
  } finally { release.resolve({ url: 'https://audio.example/test.mp3', expiresAt: Date.now() + 300_000 }) }
  await playing
  assert.deepEqual((await checking!).body, { status: 800 })
  assert.equal((await disconnecting!).status, 200)
  assert.ok(!boundAccounts.includes('MUSIC_U=qr-current'), '失效扫码结果不能广播或写入房间')
  assert.equal(repo.credential(room.id), null)
  assert.equal((await call(path)).body.account.connected, false)
})

test('HTTP：房间关闭后迟到的二维码生成结果不能恢复挑战', { timeout: 10_000 }, async (t) => {
  const { provider, server, room, path, call } = await setup(t)
  const started = deferred<void>(), release = deferred<{ key: string; image: string }>()
  provider.qrHandler = () => { started.resolve(); return release.promise }
  const generating = call(`${path}/account/qr`, 'POST')
  try {
    await started.promise
    assert.equal((await call(path, 'DELETE')).status, 200)
  } finally { release.resolve({ key: 'closed-room-key', image: 'data:image/png;base64,closed' }) }
  assert.equal((await generating).status, 404)
  assert.equal(server.rooms.rooms.has(room.id), false)
})
