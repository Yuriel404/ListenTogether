import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LocalVolumeController } from '../client/src/audio-volume.js'
import { AudioFocus } from '../client/src/audio-focus.js'

test('拖动音量立即影响播放器，静音设置 muted，恢复用户之前的音量且不改变播放状态', () => {
  const audio = { volume: 1, muted: false, paused: false, currentTime: 40, playbackRate: 1 }
  const volume = new LocalVolumeController(audio)
  volume.set(0.23)
  assert.equal(audio.volume, 0.23)
  assert.equal(volume.toggle(), 0)
  assert.equal(audio.muted, true)
  assert.equal(volume.toggle(), 0.23)
  assert.equal(audio.muted, false)
  assert.equal(audio.volume, 0.23)
  assert.equal(audio.paused, false)
  assert.equal(audio.currentTime, 40)
  assert.equal(audio.playbackRate, 1)
})

test('零音量后拖动可取消静音，非法或超范围值不会破坏播放器', () => {
  const audio = { volume: 0.7, muted: false }
  const volume = new LocalVolumeController(audio, 0)
  assert.equal(audio.muted, true)
  volume.set(0.5)
  assert.equal(audio.muted, false)
  assert.equal(volume.set(NaN), 0.5)
  assert.equal(volume.set(5), 1)
  assert.equal(volume.set(-1), 0)
  assert.equal(volume.toggle(), 1)
})

test('用真实广播通道验证多标签播放接管：新的收听页使旧页停止，本页不响应自己的消息', { timeout: 2000 }, async (t) => {
  const name = `listen-focus-test-${randomUUID()}`
  let firstYields = 0, secondYields = 0
  let resolveFirst!: () => void, resolveSecond!: () => void
  const firstYield = new Promise<void>((resolve) => { resolveFirst = resolve })
  const secondYield = new Promise<void>((resolve) => { resolveSecond = resolve })
  const first = new AudioFocus(new BroadcastChannel(name), 'first', () => { firstYields++; resolveFirst() })
  const second = new AudioFocus(new BroadcastChannel(name), 'second', () => { secondYields++; resolveSecond() })
  t.after(() => { first.close(); second.close() })
  first.take()
  await secondYield
  assert.equal(firstYields, 0)
  assert.equal(secondYields, 1)
  second.take()
  await firstYield
  assert.equal(firstYields, 1)
  assert.equal(secondYields, 1)
})
