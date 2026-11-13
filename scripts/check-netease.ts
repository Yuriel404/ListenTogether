import type { Track } from '../shared/types.js'
import { AppError } from '../server/errors.js'
import { NeteaseProvider } from '../server/music.js'

const provider = new NeteaseProvider()
// 播放接口只使用歌曲 ID，单独准备参数以便在详情查询失败时仍然检查播放。
const track: Track = { id: '417833518', title: 'Waves', artists: [], album: '', coverUrl: '', duration: 0, vip: false }

async function check(name: string, run: () => Promise<{ ok: boolean; [key: string]: unknown }>) {
  try {
    const result = await run()
    return { check: name, ...result }
  } catch (error) {
    return error instanceof AppError
      ? { check: name, ok: false, status: error.status, message: error.message }
      : { check: name, ok: false }
  }
}

// SDK 会用 console.log 输出整份上游错误，其中可能含 Set-Cookie。此独立诊断进程只输出以下检查结果。
console.log = () => {}
const results = await Promise.all([
  check('qr', async () => {
    const qr = await provider.qr()
    return { ok: !!qr.key && qr.image.startsWith('data:image/') }
  }),
  check('search', async () => {
    const result = await provider.search('周杰伦', 0, null)
    return { ok: result.tracks.length > 0, tracks: result.tracks.length, total: result.total }
  }),
  check('track', async () => {
    const result = await provider.track(track.id, null)
    return { ok: result.id === track.id, trackId: track.id }
  }),
  check('stream', async () => {
    const stream = await provider.stream(track, '__listen_anonymous=1', 'diagnostic')
    return { ok: stream.url.startsWith('https:'), trackId: track.id, bitrate: stream.bitrate }
  }),
])

for (const result of results) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
}
