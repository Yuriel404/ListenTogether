import { useEffect, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowRight, AudioLines, Link, Music2, Plus } from 'lucide-react'
import type { RoomSnapshot, SessionInfo } from '../../shared/types'
import { errorText, post, request, savedNickname, saveNickname } from './api'
import { Dialog, Spinner } from './ui'

interface RecentRoom { id: string; name: string; owner: boolean; online: number }

export function Home({ session, navigate }: { session: SessionInfo; navigate: (path: string) => void }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('今晚，一起听')
  const [nickname, setNickname] = useState(savedNickname() || (session.user.nickname === '新朋友' ? '' : session.user.nickname))
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState('')
  const [recentError, setRecentError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState<RecentRoom[]>([])
  useEffect(() => { void request<RecentRoom[]>('/api/rooms').then(setRecent).catch((err) => setRecentError(errorText(err))) }, [])

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const room = await post<RoomSnapshot>('/api/rooms', { name, nickname, password: password || undefined })
      saveNickname(nickname)
      navigate(`/room/${room.id}`)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const join = (event: FormEvent) => {
    event.preventDefault(); setError('')
    const id = /^([A-Za-z0-9_-]{12})$/.exec(invite.trim())?.[1] || /\/room\/([A-Za-z0-9_-]{12})(?:[/?#]|$)/.exec(invite.trim())?.[1]
    if (!id) { setError('请粘贴完整邀请链接或 12 位房间号'); return }
    navigate(`/room/${id}`)
  }

  return <main className="home-page">
    <section className="home-hero">
      <div className="hero-copy"><h1>同频听歌室</h1><div className="hero-actions"><button className="button primary large" onClick={() => { setError(''); setCreating(true) }}><Plus size={20} />创建听歌室<ArrowRight size={18} /></button><a className="text-link" href="#join-room">加入房间<ArrowDown size={16} /></a></div></div>
      <div className="hero-visual" aria-hidden="true"><div className="hero-disc"><div className="disc-label"><AudioLines size={43} /><span>LISTEN<br />TOGETHER</span><i /></div></div></div>
    </section>

    <section className="home-lower" id="join-room"><div className="join-card"><h2>加入房间</h2><form onSubmit={join} className="invite-form"><Link size={19} /><input aria-label="邀请链接或房间号" placeholder="粘贴邀请链接 / 输入房间号" value={invite} onChange={(e) => setInvite(e.target.value)} required /><button className="join-submit" aria-label="加入听歌室"><ArrowRight size={21} /></button></form>{error && !creating && <p className="error-text" role="alert">{error}</p>}</div></section>

    {!!recent.length && <section className="recent-section"><div className="section-heading"><h2>最近的听歌室</h2></div><div className="recent-grid">{recent.map((room) => <button key={room.id} className="recent-card" onClick={() => navigate(`/room/${room.id}`)}><span className="recent-icon"><Music2 size={24} /></span><span className="recent-copy"><strong>{room.name}</strong><small>{room.owner ? '你是房主' : '已加入'} · {room.online} 人在线</small></span><ArrowRight size={17} /></button>)}</div></section>}
    {recentError && <p className="muted">最近的房间暂时无法加载：{recentError}</p>}

    {creating && <Dialog title="创建你的听歌室" onClose={() => { if (!busy) setCreating(false) }}><form className="form-stack" onSubmit={create}><label>房间名称<input maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：今晚，一起听" required /></label><label>你的昵称<input maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="朋友怎么称呼你？" required /></label><label>房间密码<span className="field-hint">可选</span><input type="password" autoComplete="new-password" maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="不设置则凭邀请链接加入" /></label>{error && <p className="error-text" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? <Spinner label="创建中…" /> : <><Plus size={18} />创建并进入房间</>}</button></form></Dialog>}
  </main>
}
