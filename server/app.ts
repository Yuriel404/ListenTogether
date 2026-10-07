import express, { type NextFunction, type Request, type Response } from 'express'
import { createServer } from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Server } from 'socket.io'
import { z } from 'zod'
import { playbackModes, type Ack, type PlayerCommand } from '../shared/types.js'
import type { Config } from './config.js'
import { AppError, publicError } from './errors.js'
import { DemoProvider, NeteaseProvider, synthesizeDemo, type MusicProvider } from './music.js'
import { Repository, type Session } from './repository.js'
import { RoomService } from './rooms.js'

const nicknameSchema = z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 个字符')
const inputSchema = z.object({ input: z.string().trim().min(1, '请填写链接或歌曲 ID').max(2000) })
const commandSchema = z.object({ type: z.enum(['play', 'pause', 'seek', 'next', 'previous', 'select', 'mode']), queueId: z.string().uuid().optional(), position: z.number().finite().min(0).max(86400).optional(), mode: z.enum(playbackModes).optional() })
const cookieName = 'listen_session'

function cookieToken(header?: string): string | undefined {
  const raw = header?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  try { return raw ? decodeURIComponent(raw) : undefined } catch { return undefined }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

class RateLimiter {
  private windows = new Map<string, { count: number; reset: number }>()
  check(key: string, limit: number, interval = 60_000): void {
    const now = Date.now()
    let window = this.windows.get(key)
    if (!window || window.reset <= now) {
      window = { count: 0, reset: now + interval }
      this.windows.set(key, window)
    }
    if (++window.count > limit) throw new AppError(429, '操作太频繁，请稍后重试')
  }
  prune(): void {
    const now = Date.now()
    for (const [key, value] of this.windows) if (value.reset <= now) this.windows.delete(key)
  }
}

export function createApplication(config: Config, options: { repository?: Repository; provider?: MusicProvider } = {}) {
  const repo = options.repository || new Repository(join(config.dataDir, 'listen.sqlite'), config.credentialKey)
  const provider = options.provider || (config.provider === 'demo' ? new DemoProvider() : new NeteaseProvider())
  const rooms = new RoomService(repo, provider)
  const app = express()
  const http = createServer(app)
  const rate = new RateLimiter()
  const sessions = new WeakMap<Request, Session>()
  const challenges = new Map<string, { id: string; key: string; ownerId: string; expiresAt: number; status: number; lastPoll: number; inFlight: boolean }>()
  const demoAudio = new Map<string, Buffer>()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', 1)

  const csrf = (session: Session) => createHmac('sha256', config.sessionSecret).update(session.id).digest('base64url')
  const sessionFor = (req: Request): Session => {
    const session = sessions.get(req)
    if (!session) throw new AppError(401, '会话已过期，请刷新页面')
    return session
  }
  const validOrigin = (origin: string | undefined, host: string | undefined) => {
    if (!origin) return true
    if (config.publicOrigins.includes(origin)) return true
    // 同源部署可直接访问，跨源连接必须显式配置 PUBLIC_ORIGIN。
    return origin === `http://${host}` || origin === `https://${host}`
  }

  const io = new Server(http, {
    serveClient: false,
    maxHttpBufferSize: 16_384,
    allowRequest: (req, callback) => callback(null, validOrigin(req.headers.origin, req.headers.host)),
  })
  rooms.onChange = (snapshot) => io.to(snapshot.id).emit('room:state', snapshot)
  rooms.onError = (id, message) => io.to(id).emit('room:error', message)

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET' && req.method !== 'HEAD' && !validOrigin(req.headers.origin, req.headers.host)) {
      next(new AppError(403, '请求来源不受信任'))
    } else next()
  })
  app.use(express.json({ limit: '24kb' }))
  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: provider.mode }))

  app.get('/api/session', (req, res, next) => {
    try {
      rate.check(`session:${req.ip}`, 90)
      let session = repo.findSession(cookieToken(req.headers.cookie))
      if (!session) {
        const created = repo.createSession()
        session = created.session
        res.cookie(cookieName, created.token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookie, maxAge: 30 * 86400_000, path: '/' })
      }
      res.json({ user: { id: session.publicId, nickname: session.nickname }, csrfToken: csrf(session), provider: provider.mode })
    } catch (error) { next(error) }
  })

  app.use('/api', (req, _res, next) => {
    try {
      const session = repo.findSession(cookieToken(req.headers.cookie))
      if (!session) throw new AppError(401, '会话已过期，请刷新页面')
      sessions.set(req, session)
      rate.check(`http:${session.id}`, 240)
      if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(req.header('x-csrf-token') || '', csrf(session))) throw new AppError(403, '请求校验失败，请刷新页面')
      next()
    } catch (error) { next(error) }
  })

  app.get('/api/rooms', (req, res) => {
    const session = sessionFor(req)
    res.json([...rooms.rooms.values()].filter((room) => repo.isMember(room.id, session.id)).map((room) => ({ id: room.id, name: room.name, owner: room.ownerSessionId === session.id, online: rooms.snapshot(room.id).members.filter((m) => m.online).length })))
  })

  app.post('/api/rooms', (req, res) => {
    const data = z.object({ name: z.string().trim().min(1, '请填写房间名称').max(40), nickname: nicknameSchema, password: z.string().max(64).optional() }).parse(req.body)
    rate.check(`create:${sessionFor(req).id}`, 10)
    res.status(201).json(rooms.create(sessionFor(req), data.name, data.nickname, data.password))
  })

  app.get('/api/rooms/:id/info', (req, res) => {
    const room = rooms.get(String(req.params.id))
    res.json({ id: room.id, name: room.name, hasPassword: !!room.passwordHash, isMember: repo.isMember(room.id, sessionFor(req).id) })
  })

  app.post('/api/rooms/:id/join', (req, res) => {
    rate.check(`join:${sessionFor(req).id}`, 20)
    const data = z.object({ nickname: nicknameSchema, password: z.string().max(64).optional() }).parse(req.body)
    res.json(rooms.join(String(req.params.id), sessionFor(req), data.nickname, data.password))
  })

  app.get('/api/rooms/:id', (req, res) => {
    rooms.member(String(req.params.id), sessionFor(req))
    res.json(rooms.snapshot(String(req.params.id)))
  })

  app.get('/api/rooms/:id/search', async (req, res) => {
    const id = String(req.params.id)
    rooms.member(id, sessionFor(req))
    rate.check(`search:${sessionFor(req).id}`, 40)
    const q = z.string().trim().min(1).max(100).parse(req.query.q)
    const offset = z.coerce.number().int().min(0).max(1000).default(0).parse(req.query.offset)
    res.json(await provider.search(q, offset, repo.credential(id)))
  })

  app.post('/api/rooms/:id/queue', async (req, res) => {
    rate.check(`add:${sessionFor(req).id}`, 30)
    res.json(await rooms.add(String(req.params.id), sessionFor(req), inputSchema.parse(req.body).input))
  })
  app.post('/api/rooms/:id/playlist', async (req, res) => {
    rate.check(`playlist:${sessionFor(req).id}`, 6)
    res.json(await rooms.add(String(req.params.id), sessionFor(req), inputSchema.parse(req.body).input, true))
  })
  app.delete('/api/rooms/:id/queue/:queueId', async (req, res) => {
    res.json(await rooms.remove(String(req.params.id), sessionFor(req), String(req.params.queueId)))
  })
  app.get('/api/rooms/:id/stream', async (req, res) => {
    const queueId = z.string().uuid().parse(req.query.queueId)
    if (req.query.refresh === '1') rate.check(`refresh:${sessionFor(req).id}`, 5)
    res.json(await rooms.stream(String(req.params.id), sessionFor(req), queueId, req.query.refresh === '1'))
  })
  app.get('/api/rooms/:id/lyric', async (req, res) => {
    const id = String(req.params.id)
    rooms.member(id, sessionFor(req))
    const trackId = z.string().regex(/^[1-9]\d{0,17}$/).parse(req.query.trackId)
    res.json({ lyric: await provider.lyric(trackId, repo.credential(id)) })
  })
  app.get('/api/rooms/:id/messages', (req, res) => {
    rooms.member(String(req.params.id), sessionFor(req))
    res.json(repo.messages(String(req.params.id)))
  })

  app.post('/api/rooms/:id/account/qr', async (req, res) => {
    const id = String(req.params.id), session = sessionFor(req)
    rooms.owner(id, session)
    rate.check(`qr:${session.id}`, 10)
    const result = await provider.qr()
    rooms.owner(id, session)
    const challenge = { id: randomUUID(), key: result.key, ownerId: session.id, expiresAt: Date.now() + 180_000, status: 801, lastPoll: 0, inFlight: false }
    challenges.set(id, challenge)
    res.json({ requestId: challenge.id, image: result.image, expiresAt: challenge.expiresAt })
  })

  app.post('/api/rooms/:id/account/qr/:requestId/check', async (req, res) => {
    const id = String(req.params.id), session = sessionFor(req)
    rooms.owner(id, session)
    const challenge = challenges.get(id)
    if (!challenge || challenge.id !== req.params.requestId || challenge.ownerId !== session.id || challenge.expiresAt < Date.now()) {
      res.json({ status: 800 }); return
    }
    if (challenge.status === 803 || challenge.inFlight || Date.now() - challenge.lastPoll < 1500) {
      res.json({ status: challenge.status }); return
    }
    challenge.inFlight = true
    challenge.lastPoll = Date.now()
    try {
      const result = await provider.checkQr(challenge.key)
      if (challenges.get(id) !== challenge) { res.json({ status: 800 }); return }
      if (result.status === 803 && result.account) await rooms.connectAccount(id, session, result.account)
      challenge.status = result.status
      res.json({ status: challenge.status })
    } finally { challenge.inFlight = false }
  })

  app.post('/api/rooms/:id/account/cookie', async (req, res) => {
    const id = String(req.params.id), session = sessionFor(req)
    rooms.owner(id, session)
    if (provider.mode === 'demo') throw new AppError(400, '演示模式不接收真实网易云凭据')
    rate.check(`cookie:${session.id}`, 8)
    const cookie = z.string().trim().min(10).max(8000).parse(req.body?.cookie)
    const account = await provider.account(cookie)
    challenges.delete(id)
    res.json(await rooms.connectAccount(id, session, account))
  })
  app.post('/api/rooms/:id/account/demo', async (req, res) => {
    const id = String(req.params.id), session = sessionFor(req)
    rooms.owner(id, session)
    if (provider.mode !== 'demo') throw new AppError(404, '真实模式未启用演示登录')
    res.json(await rooms.connectAccount(id, session, await provider.account('local-demo')))
  })
  app.delete('/api/rooms/:id/account', async (req, res) => {
    const id = String(req.params.id)
    rooms.owner(id, sessionFor(req))
    challenges.delete(id)
    res.json(await rooms.disconnectAccount(id, sessionFor(req)))
  })

  app.delete('/api/rooms/:id', async (req, res) => {
    const id = String(req.params.id)
    await rooms.close(id, sessionFor(req))
    challenges.delete(id)
    io.to(id).emit('room:closed')
    io.in(id).disconnectSockets(true)
    res.json({ ok: true })
  })

  app.get('/api/rooms/:id/demo-audio/:trackId', (req, res) => {
    const room = rooms.member(String(req.params.id), sessionFor(req))
    if (provider.mode !== 'demo') throw new AppError(404, '演示音源未启用')
    const id = z.string().regex(/^[1-6]$/).parse(req.params.trackId)
    if (!room.account.connected) throw new AppError(403, '房主尚未连接音源')
    let audio = demoAudio.get(id)
    if (!audio) { audio = synthesizeDemo(id); demoAudio.set(id, audio) }
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Accept-Ranges', 'bytes')
    const range = req.headers.range
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) { res.status(416).setHeader('Content-Range', `bytes */${audio.length}`); res.end(); return }
      const start = match[1] ? Number(match[1]) : Math.max(0, audio.length - Number(match[2]))
      const end = match[1] && match[2] ? Math.min(Number(match[2]), audio.length - 1) : audio.length - 1
      if (!Number.isSafeInteger(start) || start >= audio.length || start > end) { res.status(416).setHeader('Content-Range', `bytes */${audio.length}`); res.end(); return }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${audio.length}`)
      res.setHeader('Content-Length', end - start + 1)
      res.end(audio.subarray(start, end + 1)); return
    }
    res.setHeader('Content-Length', audio.length)
    res.end(audio)
  })

  io.use((socket, next) => {
    try {
      const session = repo.findSession(cookieToken(socket.handshake.headers.cookie))
      if (!session || !safeEqual(String(socket.handshake.auth.csrfToken || ''), csrf(session))) throw new AppError(401, '连接校验失败，请刷新页面')
      const roomId = z.string().regex(/^[A-Za-z0-9_-]{12}$/).parse(socket.handshake.auth.roomId)
      rooms.member(roomId, session)
      rate.check(`socket-connect:${session.id}`, 30)
      socket.data.session = session
      socket.data.roomId = roomId
      next()
    } catch (error) { next(new Error(publicError(error))) }
  })

  io.on('connection', (socket) => {
    const session = socket.data.session as Session, roomId = socket.data.roomId as string
    void socket.join(roomId)
    rooms.presence(roomId, session.id, true)
    socket.emit('room:state', rooms.snapshot(roomId))
    socket.emit('chat:history', repo.messages(roomId))
    socket.on('clock:ping', (ack: (time: number) => void) => {
      try { rooms.member(roomId, session); rate.check(`clock:${socket.id}`, 100); if (typeof ack === 'function') ack(Date.now()) } catch { socket.disconnect(true) }
    })
    socket.on('room:sync', (ack: (result: Ack<ReturnType<RoomService['snapshot']>>) => void) => {
      if (typeof ack !== 'function') return
      try { rooms.member(roomId, session); rate.check(`sync:${socket.id}`, 40); ack({ ok: true, data: rooms.snapshot(roomId) }) }
      catch (error) { ack({ ok: false, error: publicError(error) }) }
    })
    socket.on('player:command', async (input: PlayerCommand, ack: (result: Ack<ReturnType<RoomService['snapshot']>>) => void) => {
      if (typeof ack !== 'function') return
      try {
        rate.check(`player:${session.id}`, 60)
        const data = commandSchema.parse(input)
        if (data.type === 'seek' && data.position === undefined) throw new AppError(400, '请提供播放位置')
        if (data.type === 'select' && !data.queueId) throw new AppError(400, '请提供队列歌曲')
        if (data.type === 'mode' && !data.mode) throw new AppError(400, '请选择播放方式')
        ack({ ok: true, data: await rooms.command(roomId, session, data) })
      } catch (error) { ack({ ok: false, error: error instanceof z.ZodError ? '播放指令格式不正确' : publicError(error) }) }
    })
    socket.on('chat:send', (input: unknown, ack: (result: Ack<unknown>) => void) => {
      if (typeof ack !== 'function') return
      try {
        rate.check(`chat:${session.id}`, 30)
        const { text } = z.object({ text: z.string().trim().min(1).max(500, '消息最多 500 字') }).parse(input)
        const message = rooms.chat(roomId, session, text)
        io.to(roomId).emit('chat:message', message)
        ack({ ok: true, data: message })
      } catch (error) { ack({ ok: false, error: publicError(error) }) }
    })
    socket.on('disconnect', () => rooms.presence(roomId, session.id, false))
  })

  const publicDir = resolve('dist')
  if (existsSync(join(publicDir, 'index.html'))) {
    app.use(express.static(publicDir))
    app.get('/{*path}', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) { next(); return }
      res.sendFile(join(publicDir, 'index.html'))
    })
  }
  app.use((_req, _res, next) => next(new AppError(404, '接口不存在')))
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues[0]?.message || '输入格式不正确' }); return }
    if (error instanceof SyntaxError) { res.status(400).json({ error: '请求 JSON 格式不正确' }); return }
    const status = error instanceof AppError ? error.status : 500
    // 不记录 SDK 原始错误，避免 HTTP 请求配置携带的 Cookie 进入日志。
    if (status === 500) console.error('请求处理失败:', error instanceof Error ? error.name : 'UnknownError')
    res.status(status).json({ error: publicError(error) })
  })

  const tick = setInterval(() => rooms.tick(), 500)
  const sync = setInterval(() => {
    for (const id of rooms.rooms.keys()) if (io.sockets.adapter.rooms.has(id)) io.to(id).emit('room:state', rooms.snapshot(id))
  }, 5000)
  const cleanup = setInterval(() => {
    rate.prune()
    for (const [id, value] of challenges) if (value.expiresAt < Date.now()) challenges.delete(id)
  }, 60_000)
  tick.unref(); sync.unref(); cleanup.unref()

  const close = async () => {
    clearInterval(tick); clearInterval(sync); clearInterval(cleanup)
    await new Promise<void>((done) => io.close(() => done()))
    repo.close()
  }
  return { app, http, io, rooms, repo, close }
}
