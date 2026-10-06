import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoTracks, NeteaseProvider } from '../server/music.js'

test('全新 SDK 模块进程无 xeapi 公钥时仍可播放，多个房间的登录凭据独立传入', async () => {
  const cookies: unknown[] = []
  const provider = new NeteaseProvider({
    song_url_v1: async (params) => {
      // 模拟新版 SDK：默认 xeapi 在未运行 CLI 初始化时会直接抛错。
      if (params.crypto !== 'eapi') throw new Error('xeapi public key is missing')
      cookies.push(params.cookie)
      return { body: { data: [{ url: 'https://music.example/full.mp3', freeTrialInfo: null, expi: 120 }] } }
    },
  })
  const streams = await Promise.all([
    provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'),
    provider.stream(demoTracks[0], 'MUSIC_U=room-b', 'room-b'),
  ])
  assert.equal(streams.length, 2)
  assert.deepEqual(cookies.sort(), ['MUSIC_U=room-a', 'MUSIC_U=room-b'])
})

test('上游播放失败不泄漏凭据，重试能够恢复，eapi 的试听标记仍被拒绝', async () => {
  let fail = true
  let trial: unknown = null
  const provider = new NeteaseProvider({
    song_url_v1: async () => {
      if (fail) throw new Error('private upstream diagnostic MUSIC_U=room-a')
      return { body: { data: [{ url: 'https://music.example/full.mp3', freeTrialInfo: trial }] } }
    },
  })
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), { message: '网易云请求失败，请稍后重试或让房主重新登录' })
  fail = false
  assert.ok((await provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a')).url)
  trial = { start: 0, end: 30 }
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), /仅能试听/)
  trial = 'null'
  assert.ok((await provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a')).url)
})
