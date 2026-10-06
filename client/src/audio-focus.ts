type FocusChannel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'>

/** 同一站点的其他标签收到接管消息后停止本机收听，房间的全局播放状态保持独立。 */
export class AudioFocus {
  private receive = (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; id?: unknown } | null
    if (data?.type === 'listen' && typeof data.id === 'string' && data.id !== this.id) this.onYield()
  }

  constructor(private channel: FocusChannel, private id: string, private onYield: () => void) {
    channel.addEventListener('message', this.receive)
  }
  take(): void { this.channel.postMessage({ type: 'listen', id: this.id }) }
  close(): void { this.channel.removeEventListener('message', this.receive); this.channel.close() }
}
