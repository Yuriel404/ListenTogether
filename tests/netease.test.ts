import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoTracks, NeteaseProvider } from '../server/music.js'
import { AppError } from '../server/errors.js'

test('播放请求通过网页协议使用本房间凭据，保留极高音质并关闭第三方匹配', async () => {
  const requests: Record<string, unknown>[] = []
  const provider = new NeteaseProvider({
    song_url_v1: async (params) => {
      requests.push(params)
      return { body: { data: [{ url: 'https://music.example/full.mp3', freeTrialInfo: null, expi: 120, br: 320000 }] } }
    },
  })
  const streams = await Promise.all([
    provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'),
    provider.stream(demoTracks[1], 'MUSIC_U=room-b', 'room-b'),
  ])
  assert.equal(streams[0].bitrate, 320000)
  assert.deepEqual(requests.map(({ id, cookie, crypto, level, unblock }) => ({ id, cookie, crypto, level, unblock })), [
    { id: demoTracks[0].id, cookie: 'MUSIC_U=room-a', crypto: 'weapi', level: 'exhigh', unblock: 'false' },
    { id: demoTracks[1].id, cookie: 'MUSIC_U=room-b', crypto: 'weapi', level: 'exhigh', unblock: 'false' },
  ])
})

for (const outcome of ['resolve', 'reject']) {
  test(`SDK ${outcome} 返回 -460 时，报告上游拒绝，不重试、不透传原始消息`, async () => {
    let calls = 0
    const provider = new NeteaseProvider({
      song_url_v1: async () => {
        calls++
        const response = { status: 400, body: { code: -460, message: 'private diagnostic MUSIC_U=room-a' } }
        if (outcome === 'reject') throw response
        return response
      },
    })
    await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.match(error.message, /-460/)
      assert.match(error.message, /拒绝|限制/)
      assert.doesNotMatch(error.message, /登录过期|重新登录|private|MUSIC_U/)
      return true
    })
    assert.equal(calls, 1)
  })
}

test('上游明确返回 301 或 401 时提示房主重新登录', async () => {
  for (const code of [301, 401]) {
    const provider = new NeteaseProvider({
      song_url_v1: async () => { throw { status: code, body: { code } } },
    })
    await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.match(error.message, /登录|扫码/)
      assert.match(error.message, /失效|过期|重新/)
      return true
    })
  }
})

test('SDK 网络超时只提示网络或超时问题', async () => {
  const provider = new NeteaseProvider({
    song_url_v1: async () => { throw { status: 502, body: { code: 502, msg: 'timeout of 12000ms exceeded' } } },
  })
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.match(error.message, /网络|超时/)
    assert.doesNotMatch(error.message, /登录|扫码/)
    return true
  })
})

test('未知播放错误不泄漏凭据，重新发起请求可恢复，试听歌曲仍被拒绝', async () => {
  let fail = true
  let trial: unknown = null
  const provider = new NeteaseProvider({
    song_url_v1: async () => {
      if (fail) throw new Error('private upstream diagnostic MUSIC_U=room-a')
      return { body: { data: [{ url: 'https://music.example/full.mp3', freeTrialInfo: trial }] } }
    },
  })
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.doesNotMatch(error.message, /private|MUSIC_U|room-a|重新登录/)
    return true
  })
  fail = false
  assert.ok((await provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a')).url)
  trial = { start: 0, end: 30 }
  await assert.rejects(provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a'), /仅能试听/)
  trial = 'null'
  assert.ok((await provider.stream(demoTracks[0], 'MUSIC_U=room-a', 'room-a')).url)
})
