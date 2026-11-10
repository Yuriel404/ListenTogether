import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamInfo } from '../shared/types.js'
import { AudioStreamLoader, type AudioStreamTarget } from '../client/src/audio-stream.js'

const first = { roomId: 'room-a', queueId: 'song-1' }
const second = { roomId: 'room-a', queueId: 'song-2' }
const stream = (id: string): StreamInfo => ({ url: `https://audio.example/${id}`, expiresAt: Date.now() + 60000 })
const flush = () => new Promise<void>((done) => setImmediate(done))

function setup() {
  const calls: { target: AudioStreamTarget; refresh: boolean; signal: AbortSignal; resolve: (stream: StreamInfo) => void; reject: (error: Error) => void }[] = []
  const state = { source: '', queueId: '', loading: false, error: '', resets: 0, pauses: 0, loaded: 0 }
  const loader = new AudioStreamLoader((target, refresh, signal) => new Promise((resolve, reject) => {
    calls.push({ target, refresh, signal, resolve, reject })
  }), {
    reset: () => { state.source = ''; state.queueId = ''; state.error = ''; state.loading = false; state.resets++ },
    pause: () => { state.pauses++; state.loading = false },
    loading: () => { state.loading = true },
    loaded: (value, target) => { state.source = value.url; state.queueId = target.queueId; state.loading = false; state.loaded++ },
    error: (error) => { state.error = (error as Error).message; state.loading = false },
  })
  return { loader, calls, state }
}

test('手动刷新只用于当前请求，后续切歌及重连不继承强制刷新', async () => {
  const { loader, calls, state } = setup()
  loader.update(first, true); await flush()
  calls[0].resolve(stream('initial')); await flush()
  loader.retry(); await flush()
  calls[1].resolve(stream('refreshed')); await flush()
  loader.update(second, true); await flush()
  calls[2].reject(new Error('network down')); await flush()
  loader.update(second, false); loader.update(second, true); await flush()
  calls[3].resolve(stream('next')); await flush()
  assert.deepEqual(calls.map((call) => [call.target.queueId, call.refresh]), [
    ['song-1', false], ['song-1', true], ['song-2', false], ['song-2', false],
  ])
  assert.equal(state.source, stream('next').url)
  assert.equal(state.error, '')
  loader.dispose()
})

test('地址获取失败后重连会重新请求，同曲已加载时重连保留原音源与缓冲', async () => {
  const { loader, calls, state } = setup()
  loader.update(first, true); await flush()
  calls[0].reject(new Error('fetch failed')); await flush()
  assert.equal(state.source, '')
  assert.equal(state.error, 'fetch failed')
  loader.update(first, false); await flush()
  assert.equal(calls.length, 1)
  loader.update(first, true); await flush()
  assert.equal(calls.length, 2)
  calls[1].resolve(stream('recovered')); await flush()
  const resets = state.resets
  loader.update(first, false)
  assert.equal(state.source, stream('recovered').url)
  loader.update(first, true); await flush()
  assert.equal(calls.length, 2)
  assert.equal(state.resets, resets)
  assert.equal(state.loaded, 1)
  assert.equal(state.error, '')
  loader.dispose()
})

test('断线中止尚未完成的请求，旧连接迟到的错误不能覆盖重连成功的音源', async () => {
  const { loader, calls, state } = setup()
  loader.update(first, true); await flush()
  loader.update(first, false)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(state.loading, false)
  assert.equal(state.pauses, 1)
  loader.update(first, true); await flush()
  calls[1].resolve(stream('reconnected')); await flush()
  calls[0].reject(new Error('late old failure')); await flush()
  assert.equal(state.source, stream('reconnected').url)
  assert.equal(state.error, '')
  assert.equal(state.loaded, 1)
  loader.dispose()
})

test('切歌和清空队列会取消旧请求，迟到成功结果不能恢复已清除的音源', async () => {
  const { loader, calls, state } = setup()
  loader.update(first, true); await flush()
  loader.update(second, true); await flush()
  assert.equal(calls[0].signal.aborted, true)
  calls[1].resolve(stream('second')); await flush()
  calls[0].resolve(stream('stale-first')); await flush()
  assert.equal(state.queueId, second.queueId)
  assert.equal(state.loaded, 1)
  loader.retry(); await flush()
  loader.update(null, true)
  assert.equal(calls[2].signal.aborted, true)
  calls[2].resolve(stream('stale-refresh')); await flush()
  assert.equal(state.source, '')
  assert.equal(state.queueId, '')
  assert.equal(state.loading, false)
  assert.equal(state.loaded, 1)
  loader.dispose()
})

test('媒体加载失败标记会触发重连重取地址，离线点击刷新不会污染下一次请求', async () => {
  const { loader, calls, state } = setup()
  loader.update(first, true); await flush()
  calls[0].resolve(stream('failed-media')); await flush()
  loader.markFailed()
  loader.update(first, false)
  loader.retry(); await flush()
  assert.equal(calls.length, 1)
  loader.update(first, true); await flush()
  assert.equal(calls[1].refresh, false)
  calls[1].resolve(stream('working-media')); await flush()
  assert.equal(state.source, stream('working-media').url)
  loader.dispose()
})

test('卸载会中止请求并忽略迟到回调，重新挂载后可以正常获取音源', async () => {
  const { loader, calls, state } = setup()
  loader.update(first, false); await flush()
  assert.equal(calls.length, 0)
  loader.update(first, true); await flush()
  loader.dispose()
  assert.equal(calls[0].signal.aborted, true)
  calls[0].resolve(stream('unmounted')); await flush()
  assert.equal(state.loaded, 0)
  loader.update(first, true); await flush()
  calls[1].resolve(stream('mounted')); await flush()
  assert.equal(state.source, stream('mounted').url)
  loader.dispose()
})
