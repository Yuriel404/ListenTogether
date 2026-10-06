import { useEffect, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowRight, AudioLines, Headphones, Link, LockKeyhole, Music2, Plus, Radio, Users } from 'lucide-react'
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
      <div className="hero-copy"><div className="eyebrow"><span className="tiny-line" />SHARED MOMENTS, SHARED MUSIC</div><h1>相隔多远，<br />都在<span className="accent-word">同一个频率。</span></h1><p className="hero-description">把耳机的另一端，留给想念的人。<br />创建一个听歌室，让喜欢的歌在彼此耳边同时响起。</p><div className="hero-actions"><button className="button primary large" onClick={() => { setError(''); setCreating(true) }}><Plus size={20} />创建听歌室<ArrowRight size={18} /></button><a className="text-link" href="#join-room">加入朋友的房间<ArrowDown size={16} /></a></div><div className="hero-footnote"><span className="mini-wave"><i /><i /><i /><i /><i /></span><span>一个房主账号 · 一份共同歌单 · 每一刻同步</span></div></div>
      <div className="hero-visual" aria-hidden="true"><div className="visual-top"><span>THE SAME FREQUENCY</span><span>33⅓ RPM</span></div><div className="hero-disc"><div className="disc-label"><AudioLines size={43} /><span>LISTEN<br />TOGETHER</span><i /></div></div><div className="visual-caption"><span className="caption-number">01 / ∞</span><span>好的音乐，<br />值得一起听。</span><div className="visual-spark">✳</div></div><div className="floating-note note-one"><Headphones size={18} />距离很远，音乐很近</div><div className="floating-note note-two"><span className="status-dot" />等待与你同频</div></div>
    </section>

    <section className="home-lower" id="join-room"><div className="join-card"><div className="section-kicker">HAVE AN INVITATION?</div><h2>朋友已经在等你了？</h2><p>粘贴邀请链接或房间号，一起听下一首。</p><form onSubmit={join} className="invite-form"><Link size={19} /><input aria-label="邀请链接或房间号" placeholder="粘贴邀请链接 / 输入房间号" value={invite} onChange={(e) => setInvite(e.target.value)} required /><button className="join-submit" aria-label="加入听歌室"><ArrowRight size={21} /></button></form>{error && !creating && <p className="error-text" role="alert">{error}</p>}</div><div className="how-card"><div className="section-kicker">MADE FOR YOUR PEOPLE</div><div className="feature-row"><span className="feature-icon"><Users size={21} /></span><div><h3>音乐是一种陪伴</h3><p>分享一个链接，让朋友加入你的听歌室。</p></div></div><div className="feature-row"><span className="feature-icon"><Radio size={21} /></span><div><h3>一起点歌，同步收听</h3><p>大家贡献歌单，房主掌控播放节奏。</p></div></div><div className="feature-row"><span className="feature-icon"><LockKeyhole size={21} /></span><div><h3>你的账号，由你保管</h3><p>房主扫码连接音源，成员无需登录网易云。</p></div></div></div></section>

    {!!recent.length && <section className="recent-section"><div className="section-heading"><h2>最近的听歌室</h2><span>熟悉的歌，熟悉的人</span></div><div className="recent-grid">{recent.map((room) => <button key={room.id} className="recent-card" onClick={() => navigate(`/room/${room.id}`)}><span className="recent-icon"><Music2 size={24} /></span><span className="recent-copy"><strong>{room.name}</strong><small>{room.owner ? '你是房主' : '已加入'} · {room.online} 人在线</small></span><ArrowRight size={17} /></button>)}</div></section>}
    {recentError && <p className="muted">最近的房间暂时无法加载：{recentError}</p>}
    <footer className="home-footer"><span>同频 / LISTEN TOGETHER</span><span>{session.provider === 'demo' ? '演示音频为本地生成；真实网易云登录请使用默认模式。' : '把平凡的一天，听成共同的回忆。'}</span></footer>

    {creating && <Dialog title="创建你的听歌室" onClose={() => { if (!busy) setCreating(false) }}><p className="dialog-description">取一个名字，邀请想一起听歌的人。</p><form className="form-stack" onSubmit={create}><label>房间名称<input maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：今晚，一起听" required /></label><label>你的昵称<input maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="朋友怎么称呼你？" required /></label><label>房间密码<span className="field-hint">可选</span><input type="password" autoComplete="new-password" maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="不设置则凭邀请链接加入" /></label>{error && <p className="error-text" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? <Spinner label="创建中…" /> : <><Plus size={18} />创建并进入房间</>}</button></form></Dialog>}
  </main>
}
