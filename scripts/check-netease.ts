import { NeteaseProvider } from '../server/music.js'

const provider = new NeteaseProvider()
const results = await Promise.allSettled([
  provider.qr().then((qr) => ({ check: 'qr', ok: !!qr.key && qr.image.startsWith('data:image/'), imageBytes: qr.image.length })),
  provider.search('周杰伦', 0, null).then((result) => ({ check: 'search', ok: result.tracks.length > 0, tracks: result.tracks.length, total: result.total })),
  provider.track('417833518', null).then(async (track) => {
    const stream = await provider.stream(track, '__listen_anonymous=1', 'diagnostic')
    return { check: 'stream', ok: stream.url.startsWith('https:'), trackId: track.id, expiresInSeconds: Math.round((stream.expiresAt - Date.now()) / 1000) }
  }),
])
for (let i = 0; i < results.length; i++) {
  const result = results[i]
  if (result.status === 'fulfilled') console.log(JSON.stringify(result.value))
  else { console.log(JSON.stringify({ check: ['qr', 'search', 'stream'][i], ok: false, message: result.reason instanceof Error ? result.reason.message : '请求失败' })); process.exitCode = 1 }
}
