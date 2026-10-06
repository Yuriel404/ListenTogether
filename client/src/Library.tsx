import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Check, ListMusic, ListPlus, LoaderCircle, Music2, Play, Plus, Search, Trash2 } from 'lucide-react'
import type { QueueItem, RoomSnapshot, Track } from '../../shared/types'
import { errorText, post, request } from './api'
import { Artwork, formatTime, Spinner } from './ui'

export function Library({ room, isOwner, canControl, select, notify }: { room: RoomSnapshot; isOwner: boolean; canControl: boolean; select: (id: string) => void; notify: (message: string, isError?: boolean) => void }) {
  const [tab, setTab] = useState<'queue' | 'search' | 'link'>('queue')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [total, setTotal] = useState(0)
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [kind, setKind] = useState<'song' | 'playlist'>('song')
  const searchAbort = useRef<AbortController | null>(null)
  const lastQuery = useRef('')
  const base = `/api/rooms/${room.id}`
  const queued = new Set(room.queue.map((item) => item.track.id))
  useEffect(() => () => searchAbort.current?.abort(), [])

  const search = async (value: string, offset = 0) => {
    if (!value.trim()) return
    searchAbort.current?.abort()
    const controller = new AbortController()
    searchAbort.current = controller
    setLoading(true); setSearchError(''); setSearched(true); lastQuery.current = value
    try {
      const result = await request<{ tracks: Track[]; total: number }>(`${base}/search?q=${encodeURIComponent(value)}&offset=${offset}`, { signal: controller.signal })
      if (!controller.signal.aborted) { setResults((previous) => offset ? [...previous, ...result.tracks] : result.tracks); setTotal(result.total) }
    } catch (error) { if (!controller.signal.aborted) setSearchError(errorText(error)) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const add = async (id: string) => {
    if (adding) return
    setAdding(id)
    try { await post(`${base}/queue`, { input: id }); notify('已加入共同的播放队列') }
    catch (err) { notify(errorText(err), true) } finally { setAdding(null) }
  }
  const submitLink = async (event: FormEvent) => {
    event.preventDefault(); if (adding) return
    setAdding('link')
    try { await post(`${base}/${kind === 'playlist' ? 'playlist' : 'queue'}`, { input }); setInput(''); setTab('queue'); notify(kind === 'playlist' ? '歌单已导入，最多导入前 100 首' : '歌曲已加入队列') }
    catch (err) { notify(errorText(err), true) } finally { setAdding(null) }
  }
  const remove = async (item: QueueItem) => {
    try { await request(`${base}/queue/${item.id}`, { method: 'DELETE' }); notify('已移除歌曲') } catch (err) { notify(errorText(err), true) }
  }

  return <section className="panel library-panel"><div className="panel-heading"><div><span className="section-kicker">OUR PLAYLIST</span><h2>共同的歌单<span className="count-badge">{room.queue.length}</span></h2></div><ListMusic size={21} className="muted" /></div><div className="tabs" role="tablist" aria-label="音乐操作"><button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>播放队列</button><button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'active' : ''} onClick={() => { setTab('search'); if (room.account.mode === 'demo' && !searched) { setQuery('推荐'); void search('推荐') } }}>搜索音乐</button><button role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}>链接点歌</button></div>
      {tab === 'queue' && <div className="library-content">{room.queue.length ? <><div className="list-subhead"><span>{room.queue.length} 首音乐 · 顺序播放</span><button className="subtle-link" onClick={() => setTab('search')}><Plus size={14} />添加</button></div><div className="track-list">{room.queue.map((item, index) => <div className={`track-row ${item.id === room.playback.queueId ? 'current' : ''}`} key={item.id}><span className="track-number">{item.id === room.playback.queueId && room.playback.playing ? <span className="mini-wave"><i /><i /><i /></span> : String(index + 1).padStart(2, '0')}</span><Artwork title={item.track.title} cover={item.track.coverUrl} id={item.track.id} className="track-cover" /><div className="track-copy"><strong>{item.track.title}{item.track.vip && <span className="vip-tag">VIP</span>}</strong><small>{item.track.artists.join(' / ')}</small><span className="requested-by">{item.addedBy} 点的歌</span></div><div className="track-actions"><span className="track-duration">{formatTime(item.track.duration / 1000)}</span>{isOwner && <><button className="icon-button small" aria-label={`播放 ${item.track.title}`} title="播放这首歌" disabled={!canControl} onClick={() => select(item.id)}><Play size={15} /></button>{item.id !== room.playback.queueId && <button className="icon-button small remove-track" aria-label={`移除 ${item.track.title}`} onClick={() => void remove(item)}><Trash2 size={14} /></button>}</>}</div></div>)}</div></> : <div className="empty-state"><span className="empty-icon"><ListMusic size={32} /></span><h3>第一首歌，交给你</h3><p>搜索喜欢的歌，<br />或把网易云分享链接粘贴过来。</p><button className="button secondary" onClick={() => { setTab('search'); if (room.account.mode === 'demo') { setQuery('推荐'); void search('推荐') } }}><Plus size={17} />添加第一首歌</button></div>}</div>}
      {tab === 'search' && <div className="library-content"><form className="search-form" onSubmit={(e) => { e.preventDefault(); void search(query) }}><Search size={17} /><input aria-label="搜索歌曲或歌手" placeholder="搜索歌曲、歌手…" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={100} required /><button aria-label="搜索" disabled={loading}>{loading ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={18} />}</button></form>{searchError && <p className="error-text" role="alert">{searchError}</p>}{!searched && <div className="search-suggestions"><p>从一首喜欢的歌开始</p><div>{(room.account.mode === 'demo' ? ['推荐', '晚风', '月亮'] : ['周杰伦', '陈奕迅', '纯音乐']).map((word) => <button key={word} onClick={() => { setQuery(word); void search(word) }}>{word}</button>)}</div></div>}{searched && !loading && !results.length && !searchError && <div className="empty-state compact"><Music2 size={30} /><p>没有找到相关歌曲，换个关键词试试。</p></div>}<div className="track-list search-results">{results.map((track, index) => <div className="track-row" key={`${track.id}-${index}`}><Artwork title={track.title} cover={track.coverUrl} id={track.id} className="track-cover" /><div className="track-copy"><strong>{track.title}{track.vip && <span className="vip-tag">VIP</span>}</strong><small>{track.artists.join(' / ')}</small></div><button className={`icon-button add-track ${queued.has(track.id) ? 'added' : ''}`} aria-label={`添加 ${track.title}`} title={queued.has(track.id) ? '已在队列中' : '加入队列'} disabled={!!adding || queued.has(track.id)} onClick={() => void add(track.id)}>{queued.has(track.id) ? <Check size={17} /> : adding === track.id ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}</button></div>)}</div>{loading && <div className="centered"><Spinner label="正在找歌…" /></div>}{results.length > 0 && results.length < total && <button className="load-more" disabled={loading} onClick={() => void search(lastQuery.current, results.length)}>加载更多</button>}</div>}
      {tab === 'link' && <div className="library-content link-content"><span className="link-illustration"><ListPlus size={37} /></span><h3>把喜欢的音乐带进来</h3><p className="muted">支持网易云分享链接、完整歌曲 / 歌单链接及数字 ID。</p><form className="form-stack" onSubmit={submitLink}><div className="segmented"><button type="button" className={kind === 'song' ? 'active' : ''} onClick={() => setKind('song')}>单首歌曲</button><button type="button" className={kind === 'playlist' ? 'active' : ''} onClick={() => setKind('playlist')}>导入歌单</button></div><label className="sr-only" htmlFor="music-link">音乐分享链接</label><textarea id="music-link" rows={4} maxLength={2000} placeholder={room.account.mode === 'demo' ? '演示歌曲 ID：1–6；导入歌单可填写任意 ID' : `粘贴网易云${kind === 'song' ? '歌曲' : '歌单'}链接，或输入 ID…`} value={input} onChange={(e) => setInput(e.target.value)} required /><button className="button primary full" disabled={!!adding}>{adding === 'link' ? <Spinner label="添加中…" /> : <><Plus size={17} />{kind === 'playlist' ? '导入共同歌单' : '加入播放队列'}</>}</button></form><p className="input-note">歌单每次导入前 100 首，自动跳过队列中已有的歌曲。</p></div>}
      <div className="panel-bottom-note"><UsersIcon />所有人都可以点歌，房主控制播放。</div>
    </section>
}

function UsersIcon() { return <Music2 size={14} /> }
