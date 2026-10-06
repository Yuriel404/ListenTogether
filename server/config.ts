import 'dotenv/config'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'

export interface Config {
  port: number
  host: string
  dataDir: string
  credentialKey: Buffer
  sessionSecret: string
  publicOrigins: string[]
  secureCookie: boolean
  trustProxy: boolean
  provider: 'netease' | 'demo'
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.DATA_DIR || (process.env.MUSIC_PROVIDER === 'demo' ? 'data/demo' : 'data'))
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  let credentialKey = process.env.CREDENTIAL_KEY || ''
  let sessionSecret = process.env.SESSION_SECRET || ''
  const production = process.env.NODE_ENV === 'production'
  if (production && (!credentialKey || sessionSecret.length < 32)) {
    throw new Error('生产环境必须配置 CREDENTIAL_KEY 和至少 32 字符的 SESSION_SECRET')
  }
  if (!credentialKey || !sessionSecret) {
    const path = join(dataDir, 'secrets.json')
    const saved: { credentialKey: string; sessionSecret: string } = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : { credentialKey: randomBytes(32).toString('base64'), sessionSecret: randomBytes(32).toString('hex') }
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(saved), { mode: 0o600, flag: 'wx' })
    credentialKey ||= saved.credentialKey
    sessionSecret ||= saved.sessionSecret
  }
  const key = Buffer.from(credentialKey, 'base64')
  if (key.length !== 32) throw new Error('CREDENTIAL_KEY 必须是 32 字节随机数据的 base64 编码')
  const port = Number(process.env.PORT || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效')
  const provider = process.env.MUSIC_PROVIDER || 'netease'
  if (provider !== 'netease' && provider !== 'demo') throw new Error('MUSIC_PROVIDER 只能是 netease 或 demo')
  return {
    port, host: process.env.HOST || '0.0.0.0', dataDir,
    credentialKey: key, sessionSecret,
    publicOrigins: (process.env.PUBLIC_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()).filter(Boolean),
    secureCookie: process.env.COOKIE_SECURE === 'true' || (production && process.env.COOKIE_SECURE !== 'false'),
    trustProxy: process.env.TRUST_PROXY === 'true', provider,
  }
}
