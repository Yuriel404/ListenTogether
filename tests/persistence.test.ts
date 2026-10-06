import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Repository } from '../server/repository.js'
import { DemoProvider } from '../server/music.js'
import { RoomService } from '../server/rooms.js'

test('文件数据库重开后可恢复房主身份、歌单、聊天和加密凭据，播放安全暂停', async () => {
  const parent = resolve('.cache/test-data')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'persistence-'))
  const path = join(dir, 'listen.sqlite'), key = randomBytes(32)
  const first = new Repository(path, key), provider = new DemoProvider(), rooms = new RoomService(first, provider)
  const { token, session } = first.createSession()
  const room = rooms.create(session, '重启测试', '房主')
  await rooms.connectAccount(room.id, session, await provider.account('demo'))
  await rooms.add(room.id, session, '1')
  await rooms.command(room.id, session, { type: 'play' })
  rooms.chat(room.id, session, '重启后仍然在')
  first.close()
  const reopened = new Repository(path, key), recovered = new RoomService(reopened, provider)
  try {
    const identity = reopened.findSession(token)!
    assert.equal(identity.publicId, session.publicId)
    assert.equal(recovered.owner(room.id, identity).id, room.id)
    assert.equal(recovered.snapshot(room.id).queue[0].track.id, '1')
    assert.equal(recovered.snapshot(room.id).playback.playing, false)
    assert.equal(reopened.messages(room.id)[0].text, '重启后仍然在')
    assert.equal(reopened.credential(room.id), 'local-demo')
  } finally {
    reopened.close()
    // 仅清理本测试在工作区中刚创建并确认范围的目录。
    assert.ok(resolve(dir).startsWith(`${parent}\\`) || resolve(dir).startsWith(`${parent}/`))
    rmSync(dir, { recursive: true, force: true })
  }
})
