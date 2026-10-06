import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, AudioLines, Check, Copy, Crown, Headphones, Link, LockKeyhole, MessageCircle, Music2, Pause, Play, Send, Settings2, ShieldCheck, SkipBack, SkipForward, Users, Volume2, VolumeX, Wifi, X } from 'lucide-react'
import type { ChatMessage, PlayerCommand, RoomSnapshot, SessionInfo } from '../../shared/types'
import { errorText, post, request, savedNickname, saveNickname } from './api'
import { useRoomConnection } from './connection'
import { useRoomAudio } from './audio'
import { AccountDialog } from './AccountDialog'
import { Library } from './Library'
import { Artwork, Avatar, Dialog, formatTime, Spinner } from './ui'

interface RoomInfo { id: string; name: string; hasPassword: boolean; isMember: boolean }

export function RoomPage({ roomId, session, onHome }: { roomId: string; session: SessionInfo; onHome: () => void }) {
  const [info, setInfo] = useState<RoomInfo | null>(null)
  const [initial, setInitial] = useState<RoomSnapshot | null>(null)
  const [joined, setJoined] = useState(false)
  const [nickname, setNickname] = useState(savedNickname() || (session.user.nickname === '新朋友' ? '' : session.user.nickname))
  const [password, setPassword] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joining, setJoining] = useState(false)
  const [accountDialog, setAccountDialog] = useState(false)
  const [inviteDialog, setInviteDialog] = useState(false)
  const [settingsDialog, setSettingsDialog] = useState(false)
  const [playbackSettings, setPlaybackSettings] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const { room, connected, messages, error, clearError, latency, getServerTime, command, chat } = useRoomConnection(roomId, session, joined, initial, onHome)
  const audio = useRoomAudio(room, connected, getServerTime)
  const current = room?.queue.find((q) => q.id === room.playback.queueId)
  const isOwner = room?.members.find((m) => m.id === session.user.id)?.role === 'owner'
  const canControl = connected && !controlBusy && !!room?.account.connected
  const inviteLink = `${location.origin}/room/${roomId}`
  const notify = (text: string, isError = false) => setToast({ text, error: isError })

  useEffect(() => {
    let active = true
    void request<RoomInfo>(`/api/rooms/${roomId}/info`).then(async (value) => {
      if (!active) return
      setInfo(value)
      if (value.isMember) {
        const state = await post<RoomSnapshot>(`/api/rooms/${roomId}/join`, { nickname: savedNickname() || session.user.nickname })
        if (active) { setInitial(state); setJoined(true) }
      }
    }).catch((err) => { if (active) setJoinError(errorText(err)) })
    return () => { active = false }
  }, [roomId])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer) }, [toast])
  useEffect(() => { if (room) document.title = `${room.name} · 同频`; return () => { document.title = '同频 · Listen Together' } }, [room?.name])

  const join = async (event: FormEvent) => {
    event.preventDefault(); setJoining(true); setJoinError('')
    try {
      const state = await post<RoomSnapshot>(`/api/rooms/${roomId}/join`, { nickname, password })
      saveNickname(nickname); setInitial(state); setJoined(true)
    } catch (err) { setJoinError(errorText(err)) } finally { setJoining(false) }
  }
  const control = async (payload: PlayerCommand) => {
    if (!room || !isOwner || controlBusy) return
    if (!room.account.connected) { setAccountDialog(true); return }
    setControlBusy(true)
    try { await command(payload) } catch (err) { notify(errorText(err), true) } finally { setControlBusy(false) }
  }
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); notify('邀请链接已复制，发给想一起听的人吧'); setTimeout(() => setCopied(false), 2500) }
    catch { setInviteDialog(true) }
  }
  const closeRoom = async () => {
    setControlBusy(true)
    try { await request(`/api/rooms/${roomId}`, { method: 'DELETE' }); onHome() }
    catch (err) { notify(errorText(err), true) } finally { setControlBusy(false) }
  }

  if (!joined) return <main className="join-page"><button className="text-link back-link" onClick={onHome}><ArrowLeft size={17} />返回首页</button><section className="join-room-card"><span className="join-room-icon"><Headphones size={38} /></span><span className="section-kicker">YOU'RE INVITED</span><h1>{info?.name || '正在寻找你的听歌室…'}</h1>{info && <><p>朋友已经在这里，把下一首歌一起听完。</p><form className="form-stack" onSubmit={join}><label>你的昵称<input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} placeholder="朋友怎么称呼你？" required /></label>{info.hasPassword && <label>房间密码<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} placeholder="向房主获取房间密码" required /></label>}<button className="button primary full" disabled={joining}>{joining ? <Spinner label="加入中…" /> : <><Headphones size={18} />加入听歌室<ArrowRight size={17} /></>}</button></form></>}{joinError && <p className="error-text" role="alert">{joinError}</p>}{!info && !joinError && <Spinner label="正在连接…" />}</section></main>
  if (!room) return <main className="boot-screen"><Spinner label="正在同步房间…" />{error && <p className="error-text">{error}</p>}</main>

  return <main className="room-page"><span hidden aria-hidden="true" ref={audio.attach} />
    <div className="room-topline"><button className="text-link" onClick={onHome}><ArrowLeft size={16} />返回大厅</button><span className={`connection-pill ${connected ? '' : 'offline'}`}><Wifi size={13} />{connected ? `已同步${latency !== null ? ` · 网络 ${latency} ms` : ''}` : '正在重新连接…'}</span></div>
    <div className="room-heading"><div><div className="section-kicker">A LITTLE ROOM FOR US</div><h1>{room.name}<span className="live-badge"><span className="status-dot" />一起听</span></h1><p>房间 {roomId} <span className="dot-separator">·</span> {isOwner ? '你是房主，掌控今天的播放节奏' : '找到你想听的歌，把它加入共同歌单'}</p></div><div className="room-heading-actions"><button className={`button account-button ${room.account.connected ? 'account-ready' : ''}`} onClick={() => { if (isOwner) setAccountDialog(true); else notify(room.account.connected ? `由房主账号「${room.account.nickname}」提供音源` : '等待房主连接网易云账号') }}>{room.account.connected ? <ShieldCheck size={16} /> : <Music2 size={16} />}{room.account.connected ? room.account.mode === 'demo' ? '演示音源已连接' : '网易云已连接' : isOwner ? session.provider === 'demo' ? '连接演示音源' : '连接网易云' : '等待房主连接'}</button><button className="button secondary" onClick={() => void copyInvite()}>{copied ? <Check size={16} /> : <Link size={16} />}邀请朋友</button>{isOwner && <button className="icon-button settings-button" onClick={() => setSettingsDialog(true)} aria-label="房间设置"><Settings2 size={20} /></button>}</div></div>
    {session.provider === 'demo' && <div className="demo-banner"><AudioLines size={16} /><span>你正在体验本地演示音源。默认启动模式支持真实网易云扫码登录和歌曲解析。</span></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={clearError} aria-label="关闭提示"><X size={16} /></button></div>}
    <div className="room-grid">
      <Library room={room} isOwner={!!isOwner} canControl={canControl} select={(id) => void control({ type: 'select', queueId: id })} notify={notify} />
      <section className="listening-panel"><div className="now-playing"><div className="now-playing-top"><span><span className="status-dot" />{room.playback.playing ? 'NOW PLAYING' : 'STAY A LITTLE LONGER'}</span><span>{current ? session.provider === 'demo' ? '本地演示音源' : '网易云音乐' : '同频电台'}</span></div><div className={`record-wrap ${room.playback.playing && audio.enabled ? 'record-playing' : ''}`}><div className="record-grooves" /><Artwork title={current?.track.title || '共同的频率'} cover={current?.track.coverUrl} id={current?.track.id || 'home'} className="record-art" /><span className="record-center" /></div><div className="current-song"><h2>{current?.track.title || '此刻，等待第一首歌'}</h2><p>{current?.track.artists.join(' / ') || '让喜欢的音乐，在彼此耳边响起'}</p></div><div className="listening-caption"><AudioLines size={14} /><span>{current ? `由 ${current.addedBy} 点播` : '同一首歌，同一个瞬间'}</span></div></div>
        {!room.account.connected && <div className="connect-source-card"><span className="source-icon"><Headphones size={22} /></span><div><h3>{isOwner ? '先连接今天的音乐' : '等待房主连接音源'}</h3><p>{isOwner ? session.provider === 'demo' ? '连接本地音源，体验共享歌单和播放同步。' : '扫码登录后，房间就能播放你账号可收听的歌曲。' : '你可以先点歌，房主连接后大家一起听。'}</p></div>{isOwner && <button className="button primary small-button" onClick={() => setAccountDialog(true)}>{session.provider === 'demo' ? '连接音源' : '扫码连接'}</button>}</div>}
        <Lyrics room={room} trackId={current?.track.id} position={audio.position} />
      </section>
      <section className="panel social-panel"><div className="members-section"><div className="panel-heading"><h2>在这里的人<span className="count-badge">{room.members.filter((m) => m.online).length}</span></h2><Users size={19} className="muted" /></div><div className="member-list">{room.members.slice().sort((a, b) => Number(b.online) - Number(a.online)).map((member, index) => <div className={`member-row ${member.online ? '' : 'member-offline'}`} key={member.id}><span className="avatar-with-status"><Avatar name={member.nickname} index={index} /><span className={member.online ? 'online-dot' : 'offline-dot'} /></span><div><strong>{member.nickname}{member.id === session.user.id && <small>（你）</small>}</strong><span>{member.role === 'owner' ? '房主' : member.online ? '一起听歌中' : '暂时离线'}</span></div>{member.role === 'owner' && <Crown size={16} className="crown" />}</div>)}</div></div><Chat messages={messages} ownId={session.user.id} connected={connected} send={chat} notify={notify} /></section>
    </div>
    <div className="player-bar"><div className="player-track"><Artwork title={current?.track.title || '等待音乐'} cover={current?.track.coverUrl} id={current?.track.id} className="player-cover" /><div><strong>{current?.track.title || '音乐即将响起'}</strong><span>{current?.track.artists.join(' / ') || '添加一首歌，开启同频时刻'}</span></div></div><div className="player-center"><div className="transport"><button className="icon-button" disabled={!isOwner || !canControl || !room.queue.length} aria-label="上一首" onClick={() => void control({ type: 'previous' })}><SkipBack size={18} /></button><button className="play-button" disabled={!isOwner || !connected || controlBusy || !room.queue.length} aria-label={room.playback.playing ? '暂停房间播放' : '开始房间播放'} onClick={() => { if (!room.playback.playing) audio.unlock(); void control({ type: room.playback.playing ? 'pause' : 'play' }) }}>{controlBusy ? <span className="spin"><AudioLines size={20} /></span> : room.playback.playing ? <Pause size={20} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><button className="icon-button" disabled={!isOwner || !canControl || !room.queue.length} aria-label="下一首" onClick={() => void control({ type: 'next' })}><SkipForward size={18} /></button>{!isOwner && <span className="member-control-note">房主控制播放</span>}</div><Progress position={audio.position} buffered={audio.buffered} duration={(current?.track.duration || 0) / 1000} disabled={!isOwner || !canControl || !current} seek={(position) => void control({ type: 'seek', position })} /></div><div className="player-local"><div className="volume-control"><button className="icon-button small" aria-label={audio.volume ? '静音本机' : '取消本机静音'} onClick={audio.toggleVolume}>{audio.volume ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><input type="range" aria-label="本机音量" aria-valuetext={`${Math.round(audio.volume * 100)}%`} title={`音量 ${Math.round(audio.volume * 100)}%`} min="0" max="1" step="0.01" value={audio.volume} onInput={(e) => audio.setVolume(Number(e.currentTarget.value))} onChange={(e) => audio.setVolume(Number(e.target.value))} style={{ '--volume': `${audio.volume * 100}%` } as React.CSSProperties} /></div><button className="icon-button small buffer-settings-button" aria-label="本机播放设置" title="播放缓冲设置" onClick={() => setPlaybackSettings(true)}><Settings2 size={17} /></button>{!audio.enabled || audio.blocked ? <button className="button primary listen-button" onClick={audio.unlock}><Headphones size={16} />开启声音</button> : <button className="button secondary listen-button" onClick={audio.mute}><Headphones size={16} />停止收听</button>}{current && <span className="local-player-status">{audio.loading ? '正在缓冲' : '已缓冲'} · {Math.floor(audio.buffered)} 秒</span>}</div></div>
    {audio.error && <div className="audio-error" role="alert"><span>{audio.error}</span><button onClick={audio.retry}>刷新地址</button></div>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">{toast.error ? <X size={17} /> : <Check size={17} />}{toast.text}</div>}
    {playbackSettings && <Dialog title="本机播放设置" onClose={() => setPlaybackSettings(false)}><p className="dialog-description">提前缓冲更多音频，减少网络波动时的停顿。这项设置只用于你的浏览器。</p><div className="volume-setting"><label>本机音量<span>{Math.round(audio.volume * 100)}%</span><input type="range" aria-label="设置音量" aria-valuetext={`${Math.round(audio.volume * 100)}%`} min="0" max="1" step="0.01" value={audio.volume} onInput={(e) => audio.setVolume(Number(e.currentTarget.value))} onChange={(e) => audio.setVolume(Number(e.target.value))} style={{ '--volume': `${audio.volume * 100}%` } as React.CSSProperties} /></label><button className="button secondary small-button" onClick={audio.toggleVolume}>{audio.volume ? <VolumeX size={15} /> : <Volume2 size={15} />}{audio.volume ? '设为静音' : '恢复音量'}</button></div><label className="buffer-setting-label">预缓冲时长<select aria-label="预缓冲时长" value={audio.bufferGoal} onChange={(event) => audio.setBufferGoal(Number(event.target.value))}><option value={15}>15 秒 · 较快开始</option><option value={30}>30 秒 · 推荐</option><option value={60}>60 秒 · 网络不稳定时</option></select></label><p className="buffer-setting-status">当前已缓冲 {Math.floor(audio.buffered)} 秒。{audio.loading ? '缓冲完成后会自动对齐房间进度。' : '较长的预缓冲可能增加开始播放时的等待。'}</p><button className="button primary full" onClick={() => setPlaybackSettings(false)}>完成</button></Dialog>}
    {accountDialog && isOwner && <AccountDialog room={room} onClose={() => setAccountDialog(false)} notify={notify} />}
    {inviteDialog && <Dialog title="邀请朋友一起听" onClose={() => setInviteDialog(false)}><p className="dialog-description">把下面的链接发给朋友，房间设有密码时也请一并告诉对方。</p><label className="form-stack">房间邀请链接<input readOnly value={inviteLink} onFocus={(e) => e.target.select()} /></label><button className="button primary full invite-copy" onClick={() => void copyInvite()}><Copy size={17} />复制邀请链接</button></Dialog>}
    {settingsDialog && isOwner && <Dialog title="房间设置" onClose={() => setSettingsDialog(false)}><div className="settings-row"><LockKeyhole size={20} /><div><h3>房间与账号</h3><p>离开页面会保留房间、歌单和账号连接。关闭房间会删除该房间及其登录凭据，并让成员退出。</p></div></div><button className="button secondary full" onClick={() => { setSettingsDialog(false); setAccountDialog(true) }}><ShieldCheck size={17} />管理音乐账号</button><div className="danger-section"><h3>关闭这个听歌室</h3><p>歌曲队列、聊天记录和房间账号凭据将被删除。</p><button className="button danger full" disabled={controlBusy} onClick={() => void closeRoom()}>{controlBusy ? '正在关闭…' : '确认关闭房间'}</button></div></Dialog>}
  </main>
}

function Progress({ position, buffered, duration, disabled, seek }: { position: number; buffered: number; duration: number; disabled: boolean; seek: (seconds: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null)
  return <div className="progress-row"><span>{formatTime(draft ?? position)}</span><input aria-label="播放进度" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(duration || 1, draft ?? position)} disabled={disabled} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={(e) => { if (draft !== null) { seek(Number(e.currentTarget.value)); setDraft(null) } }} onKeyUp={(e) => { if (draft !== null && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) { seek(Number(e.currentTarget.value)); setDraft(null) } }} onBlur={() => setDraft(null)} style={{ '--progress': `${duration ? (draft ?? position) / duration * 100 : 0}%`, '--buffered': `${duration ? Math.min(100, (position + buffered) / duration * 100) : 0}%` } as React.CSSProperties} /><span>{formatTime(duration)}</span></div>
}

function Lyrics({ room, trackId, position }: { room: RoomSnapshot; trackId?: string; position: number }) {
  const [lines, setLines] = useState<{ time: number; text: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setLines([]); setError('')
    if (!trackId) return
    const controller = new AbortController()
    setLoading(true)
    void request<{ lyric: string }>(`/api/rooms/${room.id}/lyric?trackId=${trackId}`, { signal: controller.signal }).then(({ lyric }) => {
      const parsed: { time: number; text: string }[] = []
      const offset = Number(/\[offset:([+-]?\d+)\]/.exec(lyric)?.[1] || 0) / 1000
      for (const row of lyric.split('\n')) {
        const text = row.replace(/\[[^\]]*\]/g, '').trim()
        if (!text) continue
        for (const stamp of row.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) parsed.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]) + offset, text })
      }
      setLines(parsed.sort((a, b) => a.time - b.time))
    }).catch((err) => { if (!controller.signal.aborted) setError(errorText(err)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [room.id, trackId])
  let index = -1
  for (let i = 0; i < lines.length; i++) { if (lines[i].time <= position) index = i; else break }
  const start = Math.max(0, index - 1)
  return <div className="lyrics-card"><div className="lyrics-heading"><span><Music2 size={14} />此刻的歌词</span><span>LYRICS</span></div><div className="lyrics-lines">{loading ? <Spinner label="正在加载歌词…" /> : lines.length ? lines.slice(start, start + 4).map((line, i) => <p className={start + i === index ? 'lyric-active' : ''} key={`${line.time}-${i}`}>{line.text}</p>) : <div className="lyrics-empty"><AudioLines size={23} /><p>{error || (trackId ? '这首歌暂无歌词，让旋律继续。' : '等音乐响起，我们一起唱。')}</p></div>}</div></div>
}

function Chat({ messages, ownId, connected, send, notify }: { messages: ChatMessage[]; ownId: string; connected: boolean; send: (text: string) => Promise<unknown>; notify: (message: string, error?: boolean) => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [messages.length])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!text.trim() || sending) return
    setSending(true)
    try { await send(text); setText('') } catch (err) { notify(errorText(err), true) } finally { setSending(false) }
  }
  return <div className="chat-section"><div className="chat-title"><span><MessageCircle size={16} />边听边聊</span><span className="status-dot" /></div><div className="chat-list" ref={list} aria-live="polite">{messages.length ? messages.map((message) => <div className={`chat-message ${message.userId === ownId ? 'chat-own' : ''}`} key={message.id}><div className="message-meta"><strong>{message.nickname}</strong><time>{new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></div>) : <div className="chat-empty"><MessageCircle size={28} /><p>歌里的心情，<br />也可以在这里分享。</p></div>}</div><form className="chat-form" onSubmit={submit}><input aria-label="聊天消息" placeholder="说点什么，让音乐有回应…" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} disabled={!connected} /><button type="submit" aria-label="发送消息" disabled={!connected || !text.trim() || sending}><Send size={17} /></button></form></div>
}
