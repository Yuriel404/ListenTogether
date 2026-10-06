import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { playbackPosition } from '../shared/types.js'
import { AppError } from '../server/errors.js'
import { NeteaseProvider, demoTracks, parseMusicId, synthesizeDemo } from '../server/music.js'
import { Repository, checkPassword, hashPassword } from '../server/repository.js'

test('解析数字 ID、网易云 hash 链接及分享文本，拒绝外部 URL 与链接类型混淆', () => {
  assert.equal(parseMusicId('123456'), '123456')
  assert.equal(parseMusicId('https://music.163.com/#/song?id=123456'), '123456')
  assert.equal(parseMusicId('分享一首歌 https://y.music.163.com/m/song?id=123456&userid=789 （来自网易云）'), '123456')
  assert.equal(parseMusicId('https://music.163.com/playlist?id=123', 'playlist'), '123')
  for (const input of ['https://example.com/song?id=123', 'https://music.163.com.evil.test/song?id=123', 'https://music.163.com/playlist?id=123', 'https://music.163.com:8080/song?id=123', 'javascript:alert(1)', '-1']) {
    assert.throws(() => parseMusicId(input), AppError)
  }
})

test('播放时间按服务端基准计算，处理延迟执行、暂停、进度上下限', () => {
  const state = { queueId: null, playing: true, position: 12, updatedAt: 1000, revision: 1 }
  assert.equal(playbackPosition(state, 3500, 60), 14.5)
  assert.equal(playbackPosition(state, 500, 60), 12)
  assert.equal(playbackPosition({ ...state, playing: false }, 3500, 60), 12)
  assert.equal(playbackPosition(state, 100000, 60), 60)
  assert.equal(playbackPosition({ ...state, position: -5, playing: false }, 0), 0)
})

test('Cookie 使用 AES-GCM 加密，并绑定房间；密文不能跨房间复用', () => {
  const repo = new Repository(':memory:', randomBytes(32))
  const base = { ownerSessionId: 'owner', name: 'test', createdAt: 0, queue: [], playback: { queueId: null, playing: false, position: 0, updatedAt: 0, revision: 0 }, account: { connected: false, mode: 'netease' as const }, passwordHash: null }
  repo.saveRoom({ ...base, id: 'room-a' }); repo.saveRoom({ ...base, id: 'room-b' })
  repo.setCredential('room-a', 'MUSIC_U=only-for-test')
  const row = repo.db.prepare('SELECT encrypted FROM credentials WHERE room_id = ?').get('room-a')!
  assert.ok(!String(row.encrypted).includes('only-for-test'))
  assert.equal(repo.credential('room-a'), 'MUSIC_U=only-for-test')
  repo.db.prepare('INSERT INTO credentials VALUES (?, ?)').run('room-b', row.encrypted)
  assert.throws(() => repo.credential('room-b'))
  repo.clearCredential('room-a'); assert.equal(repo.credential('room-a'), null)
  const { token, session } = repo.createSession()
  assert.notEqual(token, session.id)
  assert.equal(repo.findSession(token)?.publicId, session.publicId)
  assert.equal(repo.findSession('invalid'), null)
  repo.close()
})

test('房间密码带随机盐，验证正确密码并拒绝错误密码', () => {
  const first = hashPassword('朋友们')!, second = hashPassword('朋友们')!
  assert.notEqual(first, second)
  assert.equal(checkPassword('朋友们', first), true)
  assert.equal(checkPassword('陌生人', first), false)
  assert.equal(checkPassword('', null), true)
})

test('网易云适配层拒绝空音频地址及试听片段，不启用其他音源匹配', async () => {
  let result: Record<string, unknown> = { url: null }
  let captured: Record<string, unknown> = {}
  const provider = new NeteaseProvider({ song_url_v1: async (params) => { captured = params; return { body: { data: [result] } } } })
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=test', 'room'), /无法播放/)
  result = { url: 'https://music.example/preview.mp3', freeTrialInfo: { start: 0, end: 30 } }
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=test', 'room'), /仅能试听/)
  result = { url: 'http://music.example/song.mp3', freeTrialInfo: null, expi: 120 }
  const stream = await provider.stream(demoTracks[0], 'MUSIC_U=test', 'room')
  assert.equal(stream.url, 'https://music.example/song.mp3')
  assert.equal(captured.cookie, 'MUSIC_U=test')
  assert.equal(captured.unblock, 'false')
  assert.equal(captured.level, 'exhigh')
  assert.equal(captured.crypto, 'eapi')
})

test('演示 WAV 包含合法头部、准确时长与非静音采样', () => {
  const data = synthesizeDemo('1')
  assert.equal(data.toString('ascii', 0, 4), 'RIFF')
  assert.equal(data.toString('ascii', 8, 12), 'WAVE')
  assert.equal(data.readUInt32LE(24), 16000)
  assert.equal(data.readUInt32LE(40) / 2 / 16000, 90)
  assert.ok(data.subarray(32000, 32100).some((value) => value !== 0))
})
