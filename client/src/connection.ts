import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Ack, ChatMessage, PlayerCommand, RoomSnapshot, SessionInfo } from '../../shared/types'

export function useRoomConnection(roomId: string, session: SessionInfo, joined: boolean, initial: RoomSnapshot | null, onClosed: () => void) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState('')
  const [latency, setLatency] = useState<number | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const anchor = useRef({ server: Date.now(), performance: performance.now() })
  const closedRef = useRef(onClosed)
  closedRef.current = onClosed
  const getServerTime = useCallback(() => anchor.current.server + performance.now() - anchor.current.performance, [])

  useEffect(() => { if (initial) setRoom(initial) }, [initial])
  useEffect(() => {
    if (!joined) return
    const socket = io({ withCredentials: true, auth: { roomId, csrfToken: session.csrfToken }, reconnectionAttempts: Infinity })
    socketRef.current = socket
    const samples: { rtt: number; offset: number }[] = []
    let disposed = false
    const ping = () => {
      if (!socket.connected) return
      const startPerf = performance.now(), startWall = Date.now()
      socket.timeout(5000).emit('clock:ping', (err: Error | null, serverTime: number) => {
        if (disposed || err || !Number.isFinite(serverTime)) return
        const rtt = performance.now() - startPerf
        samples.push({ rtt, offset: serverTime - (startWall + rtt / 2) })
        if (samples.length > 20) samples.shift()
        const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5)
        const offsets = best.map((s) => s.offset).sort((a, b) => a - b)
        const offset = offsets[Math.floor(offsets.length / 2)]
        anchor.current = { server: Date.now() + offset, performance: performance.now() }
        setLatency(Math.round(best[0].rtt))
      })
    }
    const update = (next: RoomSnapshot) => {
      if (!samples.length) anchor.current = { server: next.serverTime, performance: performance.now() }
      setRoom((previous) => !previous || next.playback.revision >= previous.playback.revision ? next : previous)
    }
    socket.on('connect', () => { setConnected(true); setError(''); ping() })
    socket.on('disconnect', () => setConnected(false))
    socket.on('connect_error', (err: Error) => { setConnected(false); setError(err.message === 'websocket error' || err.message === 'xhr poll error' ? '连接暂时中断，正在重连…' : err.message) })
    socket.on('room:state', update)
    socket.on('room:error', setError)
    socket.on('room:closed', () => { socket.disconnect(); closedRef.current() })
    socket.on('chat:history', setMessages)
    socket.on('chat:message', (message: ChatMessage) => setMessages((list) => list.some((m) => m.id === message.id) ? list : [...list, message].slice(-100)))
    const fast = setInterval(() => { if (samples.length < 8) ping() }, 500)
    const stable = setInterval(ping, 5000)
    const visibility = () => { if (document.visibilityState === 'visible') { ping(); socket.emit('room:sync', (result: Ack<RoomSnapshot>) => { if (result.ok) update(result.data) }) } }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      clearInterval(fast); clearInterval(stable)
      document.removeEventListener('visibilitychange', visibility)
      socket.disconnect()
      socketRef.current = null
    }
  }, [roomId, session.csrfToken, joined])

  const emit = useCallback(<T,>(event: string, payload: unknown) => new Promise<T>((resolve, reject) => {
    const socket = socketRef.current
    if (!socket?.connected) { reject(new Error('正在连接房间，请稍后重试')); return }
    socket.timeout(20000).emit(event, payload, (err: Error | null, result: Ack<T>) => {
      if (err) reject(new Error('请求超时，请确认网络后重试'))
      else if (!result.ok) reject(new Error(result.error))
      else resolve(result.data)
    })
  }), [])
  const command = useCallback((payload: PlayerCommand) => emit<RoomSnapshot>('player:command', payload), [emit])
  const chat = useCallback((text: string) => emit<ChatMessage>('chat:send', { text }), [emit])
  return { room, connected, messages, error, clearError: () => setError(''), latency, getServerTime, command, chat }
}
