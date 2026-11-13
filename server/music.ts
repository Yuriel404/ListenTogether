import { MAX_QUEUE_TRACKS, PLAYLIST_PAGE_SIZE, type AccountStatus, type StreamInfo, type Track } from '../shared/types.js'
import { AppError } from './errors.js'

export interface AccountInfo {
  cookie: string
  nickname: string
  avatarUrl: string
  vipType: number
}

export interface MusicProvider {
  mode: 'netease' | 'demo'
  qr(): Promise<{ key: string; image: string }>
  checkQr(key: string): Promise<{ status: number; account?: AccountInfo }>
  account(cookie: string): Promise<AccountInfo>
  search(query: string, offset: number, cookie: string | null): Promise<{ tracks: Track[]; total: number }>
  track(input: string, cookie: string | null): Promise<Track>
  playlist(input: string, cookie: string | null): Promise<Track[]>
  stream(track: Track, cookie: string, roomId: string): Promise<StreamInfo>
  lyric(id: string, cookie: string | null): Promise<string>
}

/** 只解析网易云歌曲/歌单地址，禁止将任意 URL 交给服务器抓取。 */
export function parseMusicId(input: string, kind: 'song' | 'playlist' = 'song'): string {
  const value = input.trim()
  if (/^[1-9]\d{0,17}$/.test(value)) return value
  const match = value.match(/https?:\/\/[^\s<>，。；）)]+/)
  if (!match) throw new AppError(400, `请输入网易云${kind === 'song' ? '歌曲' : '歌单'}链接或数字 ID`)
  let url: URL
  try { url = new URL(match[0]) } catch { throw new AppError(400, '链接格式不正确') }
  if (!['music.163.com', 'y.music.163.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new AppError(400, '仅支持网易云音乐链接')
  }
  if (url.hash.startsWith('#/')) url = new URL(url.hash.slice(1), url.origin)
  const id = url.searchParams.get('id')
  if (!new RegExp(`/(?:m/)?${kind}/?$`).test(url.pathname) || !id || !/^[1-9]\d{0,17}$/.test(id)) {
    throw new AppError(400, `链接中没有有效的${kind === 'song' ? '歌曲' : '歌单'} ID`)
  }
  return id
}

async function resolveInput(input: string, kind: 'song' | 'playlist'): Promise<string> {
  const link = input.match(/https?:\/\/[^\s<>，。；）)]+/)?.[0]
  if (!link) return parseMusicId(input, kind)
  let url: URL
  try { url = new URL(link) } catch { throw new AppError(400, '链接格式不正确') }
  const allowed = new Set(['163cn.tv', '163cn.com', 'music.163.com', 'y.music.163.com'])
  for (let i = 0; i < 5; i++) {
    if (!allowed.has(url.hostname) || url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol)) {
      throw new AppError(400, '仅支持网易云音乐链接')
    }
    if (url.hostname.endsWith('music.163.com')) return parseMusicId(url.href, kind)
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    const location = res.headers.get('location')
    await res.body?.cancel()
    if (!location || res.status < 300 || res.status >= 400) break
    url = new URL(location, url)
  }
  throw new AppError(400, '暂时无法展开短链接，请在浏览器打开后复制完整网易云链接')
}

// 第三方 SDK 的返回结构随接口变化，统一在适配层归一化，不透传原始响应或 Cookie。
type ApiResult = { body: Record<string, any>; cookie?: string[] }
type Api = Record<string, (params: Record<string, unknown>) => Promise<ApiResult>>

// SDK 有时直接返回业务码，有时以 { status, body } 拒绝请求。错误正文可能含凭据。
function playbackRequestError(error: unknown): AppError {
  const failure = error as { status?: number; code?: unknown; message?: unknown; body?: { code?: unknown; msg?: unknown } } | null
  const reason = failure?.body?.msg ?? failure?.message
  if (failure?.code === 'ETIMEDOUT' || failure?.code === 'ECONNABORTED' ||
      (typeof reason === 'string' && /timeout|timed? out/i.test(reason))) {
    return new AppError(504, '获取网易云播放地址超时，请稍后重试')
  }
  const code = Number(failure?.body?.code ?? failure?.status)
  if (code === 301 || code === 401) return new AppError(401, '网易云登录已过期，请让房主重新登录')
  if (code === 429) return new AppError(429, '网易云播放请求过于频繁（429），请稍后重试')
  if (code === -460 || code === 403) return new AppError(403, `网易云拒绝了本次播放请求（${code}）`)
  const detail = Number.isSafeInteger(code) ? `（${code}）` : ''
  return new AppError(502, `获取网易云播放地址失败${detail}，请稍后重试`)
}

export class NeteaseProvider implements MusicProvider {
  readonly mode = 'netease' as const
  private apiPromise?: Promise<Api>

  constructor(api?: Api) { if (api) this.apiPromise = Promise.resolve(api) }

  private async call(name: string, params: Record<string, unknown> = {}, cookie: string | null = null): Promise<ApiResult> {
    // 显式关闭其他音源匹配，只使用房主账号在网易云的实际播放权限。
    process.env.ENABLE_GENERAL_UNBLOCK = 'false'
    this.apiPromise ??= import('@neteasecloudmusicapienhanced/api').then((module) => (module.default ?? module) as unknown as Api)
    const api = await this.apiPromise
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // 同时限制 SDK 内部请求之外的等待时间，避免上游挂起阻塞房间操作。
      const result = await Promise.race([
        api[name]({ ...params, cookie: cookie || '__listen_anonymous=1', timestamp: Date.now(), timeout: 12000, unblock: 'false' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream timeout')), 12000) }),
      ])
      return result
    } catch (error) {
      if (name === 'song_url_v1') throw playbackRequestError(error)
      throw new AppError(502, '网易云请求失败，请稍后重试或让房主重新登录')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async qr() {
    const key = (await this.call('login_qr_key')).body.data?.unikey
    if (!key) throw new AppError(502, '无法生成登录二维码，请重试')
    const image = (await this.call('login_qr_create', { key, platform: 'web', qrimg: true })).body.data?.qrimg
    if (!image) throw new AppError(502, '无法生成登录二维码，请重试')
    return { key: String(key), image: String(image) }
  }

  async checkQr(key: string) {
    const { body } = await this.call('login_qr_check', { key, noCookie: true })
    const status = Number(body.code)
    if (![800, 801, 802, 803].includes(status)) throw new AppError(502, '登录状态获取失败，请重试')
    if (status !== 803 || !body.cookie) return { status }
    return { status, account: await this.account(String(body.cookie)) }
  }

  async account(cookie: string): Promise<AccountInfo> {
    if (!/(?:^|;\s*)MUSIC_U=\S+/.test(cookie)) throw new AppError(400, 'Cookie 缺少 MUSIC_U 登录凭据')
    const profile = (await this.call('login_status', {}, cookie)).body.data?.profile
    if (!profile?.userId) throw new AppError(401, '网易云登录已过期，请重新扫码')
    return { cookie, nickname: String(profile.nickname || '网易云用户'), avatarUrl: String(profile.avatarUrl || '').replace(/^http:/, 'https:'), vipType: Number(profile.vipType || 0) }
  }

  async search(query: string, offset: number, cookie: string | null) {
    const result = (await this.call('cloudsearch', { keywords: query, type: 1, limit: 20, offset }, cookie)).body.result
    return { tracks: Array.isArray(result?.songs) ? result.songs.map(normalizeTrack) : [], total: Number(result?.songCount || 0) }
  }

  async track(input: string, cookie: string | null) {
    const id = await resolveInput(input, 'song')
    const songs = (await this.call('song_detail', { ids: id }, cookie)).body.songs
    if (!Array.isArray(songs) || !songs.length) throw new AppError(404, '未找到这首歌曲')
    return normalizeTrack(songs[0])
  }

  async playlist(input: string, cookie: string | null) {
    const id = await resolveInput(input, 'playlist')
    const body = (await this.call('playlist_detail', { id }, cookie)).body
    const playlist = body.playlist
    if ((body.code != null && body.code !== 200) || !playlist || !Array.isArray(playlist.trackIds)) {
      throw new AppError(502, '无法完整读取歌单，请检查歌单权限或稍后重试')
    }
    const tooLarge = () => new AppError(400, `歌单最多支持 ${MAX_QUEUE_TRACKS} 首，请拆分歌单后导入`)
    if (Number(playlist.trackCount) > MAX_QUEUE_TRACKS) throw tooLarge()
    if (Number(playlist.trackCount) > playlist.trackIds.length) {
      throw new AppError(502, '歌单歌曲列表不完整，请检查歌单权限或稍后重试')
    }
    const ids: string[] = []
    const seen = new Set<string>()
    for (const track of playlist.trackIds) {
      const trackId = String(track?.id ?? '')
      if (!/^[1-9]\d*$/.test(trackId)) throw new AppError(502, '歌单歌曲信息异常，请稍后重试')
      if (!seen.has(trackId)) { seen.add(trackId); ids.push(trackId) }
      if (ids.length > MAX_QUEUE_TRACKS) throw tooLarge()
    }
    if (!ids.length) throw new AppError(404, '歌单为空、不可访问或不存在')

    // 先获取完整 ID 列表，再分批读取详情；任一批次失败都不返回部分歌单。
    const tracks: Track[] = []
    for (let offset = 0; offset < ids.length; offset += PLAYLIST_PAGE_SIZE) {
      const batch = ids.slice(offset, offset + PLAYLIST_PAGE_SIZE)
      const detail = (await this.call('song_detail', { ids: batch.join(',') }, cookie)).body
      if ((detail.code != null && detail.code !== 200) || !Array.isArray(detail.songs)) {
        throw new AppError(502, '歌单歌曲详情读取失败，本次未导入，请稍后重试')
      }
      const songs = new Map<string, Track>()
      for (const song of detail.songs) {
        if (song && song.id != null) songs.set(String(song.id), normalizeTrack(song))
      }
      for (const trackId of batch) {
        const track = songs.get(trackId)
        if (!track) throw new AppError(502, '歌单中部分歌曲无法读取，本次未导入，请检查歌单权限或稍后重试')
        tracks.push(track)
      }
    }
    return tracks
  }

  async stream(track: Track, cookie: string, _roomId: string): Promise<StreamInfo> {
    // 房间采用网页登录，使用同一网页登录态向网易云请求播放地址。
    const body = (await this.call('song_url_v1', { id: track.id, level: 'exhigh', crypto: 'weapi' }, cookie)).body
    if (body?.code != null && Number(body.code) !== 200) throw playbackRequestError({ body })
    const item = body?.data?.[0]
    if (item?.code != null && Number(item.code) !== 200) throw playbackRequestError({ body: item })
    if (!item?.url) throw new AppError(403, '房主账号暂时无法播放这首歌，请检查登录和歌曲权限')
    if (item.freeTrialInfo && item.freeTrialInfo !== 'null') throw new AppError(403, '当前账号仅能试听这首歌，请选择可完整播放的歌曲')
    const url = new URL(String(item.url))
    if (!['https:', 'http:'].includes(url.protocol)) throw new AppError(502, '网易云返回了无效音频地址')
    url.protocol = 'https:'
    const bitrate = Number(item.br)
    return { url: url.href, expiresAt: Date.now() + Math.max(30, Math.min(Number(item.expi) || 300, 1200)) * 1000,
      ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {}), }
  }

  async lyric(id: string, cookie: string | null) { return String((await this.call('lyric', { id }, cookie)).body.lrc?.lyric || '') }
}

function normalizeTrack(song: Record<string, any>): Track {
  const album = song.al || song.album || {}
  return {
    id: String(song.id), title: String(song.name || '未知歌曲'),
    artists: (song.ar || song.artists || []).map((a: { name?: string }) => String(a.name || '未知歌手')),
    album: String(album.name || ''), coverUrl: String(album.picUrl || '').replace(/^http:/, 'https:'),
    duration: Number(song.dt || song.duration || 0), vip: Number(song.fee) === 1 || Number(song.fee) === 4,
  }
}

export const demoTracks: Track[] = [
  { id: '1', title: '晚风经过', artists: ['同频演示电台'], album: '窗边的片刻', coverUrl: '', duration: 90000, vip: false },
  { id: '2', title: '岛屿来信', artists: ['同频演示电台'], album: '海平面的另一边', coverUrl: '', duration: 90000, vip: false },
  { id: '3', title: '凌晨两点的月亮', artists: ['同频演示电台'], album: '不眠夜', coverUrl: '', duration: 90000, vip: false },
  { id: '4', title: '橘色日落', artists: ['同频演示电台'], album: '慢一点也没关系', coverUrl: '', duration: 90000, vip: false },
  { id: '5', title: '雨后的散步', artists: ['同频演示电台'], album: '路过春天', coverUrl: '', duration: 90000, vip: false },
  { id: '6', title: '把今天留在歌里', artists: ['同频演示电台'], album: '共同的频率', coverUrl: '', duration: 90000, vip: false },
]

export class DemoProvider implements MusicProvider {
  readonly mode = 'demo' as const
  async qr(): Promise<{ key: string; image: string }> { throw new AppError(400, '演示模式无需扫码，请连接演示音源') }
  async checkQr(_key: string): Promise<{ status: number; account?: AccountInfo }> { throw new AppError(400, '演示模式不使用网易云登录') }
  async account(_cookie: string): Promise<AccountInfo> { return { cookie: 'local-demo', nickname: '本地演示音源', avatarUrl: '', vipType: 0 } }
  async search(query: string, _offset: number, _cookie: string | null) {
    const tracks = demoTracks.filter((t) => `${t.title} ${t.artists.join(' ')} ${t.album}`.includes(query) || query === '推荐')
    return { tracks, total: tracks.length }
  }
  async track(input: string, _cookie: string | null) {
    const id = parseMusicId(input)
    const track = demoTracks.find((t) => t.id === id)
    if (!track) throw new AppError(404, '演示模式仅有歌曲 ID 1–6')
    return track
  }
  async playlist(_input: string, _cookie: string | null) { return demoTracks }
  async stream(track: Track, _cookie: string, roomId: string) {
    return { url: `/api/rooms/${roomId}/demo-audio/${track.id}`, expiresAt: Date.now() + 3600_000 }
  }
  async lyric(_id: string, _cookie: string | null) {
    return '[00:00.00]这是一段本地合成的演示旋律\n[00:12.00]让不同的屏幕，共享同一个瞬间\n[00:24.00]戴上耳机，和朋友一起慢下来\n[00:36.00]音乐正在同一个频率里流动\n[00:48.00]真实模式中，歌词会随网易云歌曲加载\n[01:00.00]下一首，也一起听吧'
  }
}

export function accountStatus(info: AccountInfo, mode: AccountStatus['mode']): AccountStatus {
  return { connected: true, nickname: info.nickname, avatarUrl: info.avatarUrl, vipType: info.vipType, mode }
}

/** 本地生成原创合成旋律，避免演示依赖第三方媒体地址。 */
export function synthesizeDemo(id: string): Buffer {
  const rate = 16000, count = rate * 90
  const buffer = Buffer.alloc(44 + count * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40)
  const notes = [261.63, 329.63, 392, 440, 349.23, 329.63, 293.66, 392]
  const shift = Number(id) % notes.length
  for (let i = 0; i < count; i++) {
    const time = i / rate, beat = time % 0.75, note = notes[(Math.floor(time / 0.75) + shift) % notes.length]
    const envelope = Math.min(1, beat * 30) * Math.exp(-beat * 4)
    const fade = Math.min(1, time / 2, (90 - time) / 2)
    const sample = (Math.sin(2 * Math.PI * note * time) * 0.16 * envelope + Math.sin(2 * Math.PI * note / 2 * time) * 0.07 * envelope + Math.sin(2 * Math.PI * 130.81 * time) * 0.035) * fade
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2)
  }
  return buffer
}
