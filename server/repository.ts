import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AccountStatus, ChatMessage, Playback, QueueItem } from '../shared/types.js'

export interface Session {
  id: string
  publicId: string
  nickname: string
  expiresAt: number
}

export interface StoredRoom {
  id: string
  ownerSessionId: string
  name: string
  createdAt: number
  queue: QueueItem[]
  playback: Playback
  account: AccountStatus
  passwordHash: string | null
}

export class Repository {
  readonly db: DatabaseSync
  constructor(path: string, private key: Buffer) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL, PRIMARY KEY(room_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS credentials (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, encrypted TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, document TEXT NOT NULL, sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id, sent_at);
    `)
  }

  createSession(): { token: string; session: Session } {
    const token = randomBytes(32).toString('base64url')
    const session = {
      id: createHash('sha256').update(token).digest('hex'), publicId: randomUUID(),
      nickname: '新朋友', expiresAt: Date.now() + 30 * 86400_000,
    }
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(session.id, session.publicId, session.nickname, session.expiresAt)
    return { token, session }
  }

  findSession(token?: string): Session | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const id = createHash('sha256').update(token).digest('hex')
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, Date.now())
    return row ? { id, publicId: String(row.public_id), nickname: String(row.nickname), expiresAt: Number(row.expires_at) } : null
  }

  renameSession(session: Session, nickname: string): void {
    session.nickname = nickname
    this.db.prepare('UPDATE sessions SET nickname = ? WHERE id = ?').run(nickname, session.id)
  }

  saveRoom(room: StoredRoom): void {
    this.db.prepare('INSERT INTO rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document').run(room.id, JSON.stringify(room))
  }

  loadRooms(): StoredRoom[] {
    return this.db.prepare('SELECT document FROM rooms').all().map((row) => JSON.parse(String(row.document)) as StoredRoom)
  }

  deleteRoom(id: string): void { this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id) }

  addMember(roomId: string, session: Session, nickname: string): void {
    this.db.prepare('INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(room_id, session_id) DO UPDATE SET nickname = excluded.nickname').run(roomId, session.id, nickname)
    this.renameSession(session, nickname)
  }

  isMember(roomId: string, sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM members WHERE room_id = ? AND session_id = ?').get(roomId, sessionId)
  }

  members(roomId: string): { sessionId: string; id: string; nickname: string }[] {
    return this.db.prepare('SELECT m.session_id, s.public_id, m.nickname FROM members m JOIN sessions s ON s.id = m.session_id WHERE m.room_id = ? AND s.expires_at > ?').all(roomId, Date.now())
      .map((row) => ({ sessionId: String(row.session_id), id: String(row.public_id), nickname: String(row.nickname) }))
  }

  setCredential(roomId: string, cookie: string): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(roomId))
    const body = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()])
    const payload = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    this.db.prepare('INSERT INTO credentials VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET encrypted = excluded.encrypted').run(roomId, payload)
  }

  credential(roomId: string): string | null {
    const row = this.db.prepare('SELECT encrypted FROM credentials WHERE room_id = ?').get(roomId)
    if (!row) return null
    const payload = Buffer.from(String(row.encrypted), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(0, 12))
    decipher.setAAD(Buffer.from(roomId))
    decipher.setAuthTag(payload.subarray(12, 28))
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
  }

  clearCredential(roomId: string): void { this.db.prepare('DELETE FROM credentials WHERE room_id = ?').run(roomId) }

  saveMessage(roomId: string, message: ChatMessage): void {
    this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(message.id, roomId, JSON.stringify(message), message.sentAt)
    this.db.prepare('DELETE FROM messages WHERE room_id = ? AND id NOT IN (SELECT id FROM messages WHERE room_id = ? ORDER BY sent_at DESC LIMIT 100)').run(roomId, roomId)
  }

  messages(roomId: string): ChatMessage[] {
    return this.db.prepare('SELECT document FROM messages WHERE room_id = ? ORDER BY sent_at, rowid').all(roomId).map((row) => JSON.parse(String(row.document)) as ChatMessage)
  }

  close(): void { this.db.close() }
}

export function hashPassword(password?: string): string | null {
  if (!password) return null
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
}

export function checkPassword(password: string, hash: string | null): boolean {
  if (!hash) return true
  const [salt, key] = hash.split(':')
  const expected = Buffer.from(key, 'hex')
  return timingSafeEqual(scryptSync(password, salt, 32), expected)
}
