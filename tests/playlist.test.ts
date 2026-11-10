import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NeteaseProvider } from '../server/music.js'
import { MAX_QUEUE_TRACKS, PLAYLIST_PAGE_SIZE } from '../shared/types.js'

const song = (id: string | number) => ({ id: Number(id), name: `歌曲 ${id}`, ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 180000 })
const playlist = (count: number) => ({ code: 200, playlist: { trackCount: count, trackIds: Array.from({ length: count }, (_, index) => ({ id: index + 1 })) } })

test('超过 100 首的歌单按 200 首分批读取，保留顺序并传递房间凭据', async () => {
  const batches: string[][] = []
  const cookies: unknown[] = []
  const provider = new NeteaseProvider({
    playlist_detail: async (params) => { assert.equal(params.id, '123'); cookies.push(params.cookie); return { body: playlist(451) } },
    song_detail: async (params) => {
      const ids = String(params.ids).split(',')
      batches.push(ids); cookies.push(params.cookie)
      return { body: { code: 200, songs: ids.map(song).reverse() } }
    },
  })
  const tracks = await provider.playlist('123', 'MUSIC_U=playlist-room')
  assert.deepEqual(batches.map((batch) => batch.length), [PLAYLIST_PAGE_SIZE, PLAYLIST_PAGE_SIZE, 51])
  assert.deepEqual(tracks.map((track) => track.id), Array.from({ length: 451 }, (_, index) => String(index + 1)))
  assert.ok(cookies.every((cookie) => cookie === 'MUSIC_U=playlist-room'))
})

test('允许恰好 1000 首，任何详情请求都不超过 200 首', async () => {
  let requests = 0
  const provider = new NeteaseProvider({
    playlist_detail: async () => ({ body: playlist(MAX_QUEUE_TRACKS) }),
    song_detail: async (params) => {
      const ids = String(params.ids).split(',')
      assert.ok(ids.length <= PLAYLIST_PAGE_SIZE); requests++
      return { body: { songs: ids.map(song) } }
    },
  })
  assert.equal((await provider.playlist('123', null)).length, MAX_QUEUE_TRACKS)
  assert.equal(requests, Math.ceil(MAX_QUEUE_TRACKS / PLAYLIST_PAGE_SIZE))
})

test('歌单重复 ID 只请求和返回一次，保持首次出现的顺序', async () => {
  const provider = new NeteaseProvider({
    playlist_detail: async () => ({ body: { playlist: { trackCount: 4, trackIds: [{ id: 3 }, { id: 1 }, { id: 3 }, { id: 2 }] } } }),
    song_detail: async (params) => { assert.equal(params.ids, '3,1,2'); return { body: { songs: [song(2), song(3), song(1)] } } },
  })
  assert.deepEqual((await provider.playlist('123', null)).map((track) => track.id), ['3', '1', '2'])
})

test('超过上限的歌单明确拒绝，不能截断成成功导入', async () => {
  for (const body of [playlist(MAX_QUEUE_TRACKS + 1), { playlist: { trackIds: playlist(MAX_QUEUE_TRACKS + 1).playlist.trackIds } }]) {
    const provider = new NeteaseProvider({
      playlist_detail: async () => ({ body }),
      song_detail: async () => { assert.fail('超出上限时不应请求歌曲详情') },
    })
    await assert.rejects(provider.playlist('123', null), /最多支持 1000 首/)
  }
})

test('空歌单、无访问权限、不完整列表和非法 ID 都不能成功导入', async () => {
  const cases = [
    { body: playlist(0), error: /歌单为空/ },
    { body: { code: 403, playlist: playlist(1).playlist }, error: /无法完整读取歌单/ },
    { body: { playlist: {} }, error: /无法完整读取歌单/ },
    { body: { playlist: { trackCount: 2, trackIds: [{ id: 1 }] } }, error: /列表不完整/ },
    { body: { playlist: { trackIds: [{ id: 1 }, {}] } }, error: /歌曲信息异常/ },
  ]
  for (const { body, error } of cases) {
    const provider = new NeteaseProvider({
      playlist_detail: async () => ({ body }),
      song_detail: async () => { assert.fail('无效歌单不应请求歌曲详情') },
    })
    await assert.rejects(provider.playlist('123', null), error)
  }
})

test('后续批次失败时整体拒绝，不返回第一批且不再请求剩余批次', async () => {
  let requests = 0
  const provider = new NeteaseProvider({
    playlist_detail: async () => ({ body: playlist(450) }),
    song_detail: async (params) => {
      requests++
      if (requests === 2) throw new Error('private upstream failure')
      return { body: { songs: String(params.ids).split(',').map(song) } }
    },
  })
  await assert.rejects(provider.playlist('123', null), /网易云请求失败/)
  assert.equal(requests, 2)
})

test('不足一页、空页、重复替代缺失歌曲以及错误状态码都不会误报成功', async () => {
  const badResponses = [
    { songs: [song(201)] },
    { songs: [] },
    { songs: [song(201), song(201)] },
    { songs: [song(201), song(202)], code: 500 },
    {},
  ]
  for (const badResponse of badResponses) {
    let requests = 0
    const provider = new NeteaseProvider({
      playlist_detail: async () => ({ body: playlist(202) }),
      song_detail: async (params) => {
        requests++
        return { body: requests === 2 ? badResponse : { songs: String(params.ids).split(',').map(song) } }
      },
    })
    await assert.rejects(provider.playlist('123', null), /本次未导入/)
    assert.equal(requests, 2)
  }
})
