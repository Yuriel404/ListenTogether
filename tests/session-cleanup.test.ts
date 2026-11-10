import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Repository, type StoredRoom } from '../server/repository.js'

test('会话有效性检查与清理使用同一过期边界，不删除有效会话', () => {
  const repo = new Repository(':memory:', randomBytes(32))
  try {
    const expired = repo.createSession(), boundary = repo.createSession(), active = repo.createSession()
    const now = Date.now()
    repo.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now - 1, expired.session.id)
    repo.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now, boundary.session.id)
    assert.equal(repo.hasActiveSession(expired.session.id, now), false)
    assert.equal(repo.hasActiveSession(boundary.session.id, now), false)
    assert.equal(repo.hasActiveSession(active.session.id, now), true)
    assert.equal(repo.hasActiveSession('missing-session', now), false)

    repo.pruneExpiredSessions(now)
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count, 1)
    assert.equal(repo.findSession(active.token)?.id, active.session.id)
    assert.equal(repo.findSession(expired.token), null)
    assert.equal(repo.findSession(boundary.token), null)
    repo.pruneExpiredSessions(now)
    assert.equal(repo.hasActiveSession(active.session.id, now), true)
  } finally { repo.close() }
})

test('清理过期会话级联删除成员关系，房间、凭据和有效成员留给房间生命周期管理', () => {
  const repo = new Repository(':memory:', randomBytes(32))
  try {
    const expiredOwner = repo.createSession(), activeGuest = repo.createSession()
    const now = Date.now()
    const room: StoredRoom = {
      id: 'cleanup-room', ownerSessionId: expiredOwner.session.id, name: '清理测试', createdAt: now,
      queue: [], playback: { queueId: null, playing: false, position: 0, updatedAt: now, revision: 0 },
      account: { connected: true, mode: 'demo' }, passwordHash: null,
    }
    repo.saveRoom(room)
    repo.addMember(room.id, expiredOwner.session, '过期房主')
    repo.addMember(room.id, activeGuest.session, '有效成员')
    repo.setCredential(room.id, 'cleanup-test-cookie')
    repo.saveMessage(room.id, { id: 'cleanup-message', nickname: '过期房主', userId: expiredOwner.session.publicId, text: '保留的消息', sentAt: now })
    repo.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now - 1, expiredOwner.session.id)

    assert.equal(repo.isMember(room.id, expiredOwner.session.id), true)
    repo.pruneExpiredSessions()
    assert.equal(repo.hasActiveSession(expiredOwner.session.id), false)
    assert.equal(repo.isMember(room.id, expiredOwner.session.id), false)
    assert.equal(repo.isMember(room.id, activeGuest.session.id), true)
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM members').get()!.count, 1)
    assert.deepEqual(repo.loadRooms(), [room])
    assert.equal(repo.credential(room.id), 'cleanup-test-cookie')
    assert.equal(repo.messages(room.id)[0].text, '保留的消息')
  } finally { repo.close() }
})
