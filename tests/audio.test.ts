import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferedSeconds, BufferedAudioController, type AudioOutput } from '../client/src/audio-sync.js'

class FakeAudio implements AudioOutput {
  private time = 0
  duration = 180
  readyState = 4
  networkState = 2
  seeking = false
  paused = true
  playbackRate = 1
  ranges: [number, number][] = [[0, 180]]
  seeks: number[] = []
  plays = 0
  get currentTime() { return this.time }
  set currentTime(value: number) { this.time = value; this.seeks.push(value); this.seeking = true; this.readyState = 2 }
  get buffered() {
    const ranges = this.ranges
    return { length: ranges.length, start: (index: number) => ranges[index][0], end: (index: number) => ranges[index][1] }
  }
  pause() { this.paused = true }
  async play() { this.plays++; this.paused = false }
  settle() { this.seeking = false; this.readyState = 4 }
  advance(seconds: number) { if (!this.paused) this.time += seconds }
}

const input = (position = 0, now = 0) => ({ position, now, duration: 180, playing: true, active: true, executeReady: true, goal: 30 })

test('连续缓冲只计入当前位置的片段，不能将 seek 后远处的缓存相加', () => {
  const audio = new FakeAudio()
  audio.ranges = [[0, 10], [50, 80]]
  assert.equal(bufferedSeconds(audio.buffered, 5), 5)
  assert.equal(bufferedSeconds(audio.buffered, 30), 0)
  assert.equal(bufferedSeconds(audio.buffered, 70), 10)
  assert.equal(bufferedSeconds(audio.buffered, 80), 0)
})

test('首次播放先等待 30 秒缓存，连续 canplay 与同步 tick 不会反复 seek 或显示加载', () => {
  const audio = new FakeAudio(), controller = new BufferedAudioController(audio)
  controller.reset(0)
  audio.ranges = [[0, 8]]
  assert.equal(controller.sync(input()).buffering, true)
  assert.equal(audio.plays, 0)
  audio.ranges = [[0, 60]]
  assert.equal(controller.sync(input(0, 500)).buffering, false)
  for (let i = 1; i <= 15; i++) {
    audio.advance(0.5)
    audio.settle() // canplay、seeked、progress 都通过同一个非强制同步入口。
    assert.equal(controller.sync(input(i * 0.5 + 0.05, 500 + i * 500)).buffering, false)
  }
  assert.equal(audio.seeks.length, 0)
  assert.equal(audio.plays, 1)
  assert.equal(audio.paused, false)
})

test('真实断粮时暂停攒缓存，不随房间每半秒向前 seek；缓冲充足后一次对齐并清除加载', async () => {
  const audio = new FakeAudio(), controller = new BufferedAudioController(audio)
  controller.reset(0); controller.sync(input())
  await new Promise<void>((done) => setImmediate(done))
  audio.advance(10)
  audio.ranges = [[0, 10.3]]; audio.readyState = 2
  controller.waiting(10000)
  for (let i = 0; i <= 12; i++) {
    assert.equal(controller.sync(input(10 + i * 0.5, 10000 + i * 500)).buffering, true)
  }
  assert.equal(audio.seeks.length, 0)
  assert.equal(audio.paused, true)
  audio.ranges = [[0, 80]]; audio.settle()
  assert.equal(controller.sync(input(17, 17000)).buffering, false)
  audio.settle()
  assert.equal(controller.sync(input(17.05, 17050)).buffering, false)
  assert.deepEqual(audio.seeks, [17])
  assert.equal(audio.paused, false)
})

test('浏览器缓存限制导致达不到目标时，8 秒后以至少 5 秒缓存恢复，避免无限加载', () => {
  const audio = new FakeAudio(), controller = new BufferedAudioController(audio)
  controller.reset(0); audio.ranges = [[0, 20]]
  assert.equal(controller.sync({ ...input(7, 7000), goal: 60 }).buffering, true)
  audio.settle()
  assert.equal(controller.sync({ ...input(8, 8000), goal: 60 }).buffering, false)
  assert.equal(audio.paused, false)
  assert.deepEqual(audio.seeks, [7, 8])
})

test('歌曲末尾以实际剩余长度为缓冲目标，暂停和停止收听不会继续等待或重新播放', () => {
  const audio = new FakeAudio(), controller = new BufferedAudioController(audio)
  controller.reset(0)
  audio.duration = 60; audio.ranges = [[55, 60]]
  controller.sync({ ...input(57), duration: 60, goal: 60 })
  audio.settle()
  assert.equal(controller.sync({ ...input(57, 500), duration: 60, goal: 60 }).buffering, false)
  assert.equal(controller.sync({ ...input(57, 1000), playing: false, align: true }).buffering, false)
  assert.equal(audio.paused, true)
  assert.equal(controller.sync({ ...input(58, 1500), active: false }).buffering, false)
  assert.equal(audio.plays, 1)
})

test('时钟小幅误差采用平缓变速，用户拖动进度只触发一次跳转，seek 的 waiting 不引发重缓冲循环', () => {
  const audio = new FakeAudio(), controller = new BufferedAudioController(audio)
  controller.reset(0); controller.sync(input())
  assert.equal(controller.sync(input(1.2, 500)).buffering, false)
  assert.equal(audio.seeks.length, 0)
  assert.equal(audio.playbackRate, 1.02)
  controller.sync({ ...input(80, 1000), align: true })
  controller.waiting(1000) // seek 过程的 waiting 应忽略。
  audio.settle()
  assert.equal(controller.sync(input(80.1, 1100)).buffering, false)
  assert.equal(controller.sync(input(80.1, 1200)).buffering, false)
  assert.deepEqual(audio.seeks, [80])
})

test('没有目标位置缓存时最多每 8 秒重新定位一次，防止网络差时不停截断下载', () => {
  const audio = new FakeAudio(), controller = new BufferedAudioController(audio)
  controller.reset(0); audio.ranges = []; audio.readyState = 1
  for (let i = 0; i <= 40; i++) {
    audio.seeking = false
    controller.sync(input(i * 0.5, i * 500))
  }
  assert.deepEqual(audio.seeks, [8, 16])
  assert.equal(audio.plays, 0)
})
