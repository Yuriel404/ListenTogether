import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SessionInfo } from '../../shared/types'
import { errorText, initializeSession } from './api'
import { Brand, Spinner } from './ui'
import { Home } from './Home'
import { RoomPage } from './RoomPage'

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState('')
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    let active = true
    void initializeSession().then((value) => { if (active) setSession(value) }).catch((err) => { if (active) setError(errorText(err)) })
    const pop = () => setPath(location.pathname)
    window.addEventListener('popstate', pop)
    return () => { active = false; window.removeEventListener('popstate', pop) }
  }, [])
  const navigate = (next: string) => { history.pushState({}, '', next); setPath(next); window.scrollTo(0, 0) }
  const roomId = /^\/room\/([A-Za-z0-9_-]{12})\/?$/.exec(path)?.[1]
  return <div className="app-shell">
    <header className="site-header"><Brand onClick={() => navigate('/')} />{session?.provider === 'demo' && <span className="header-note">本地演示模式</span>}</header>
    {!session ? <main className="boot-screen">{error ? <><p className="error-text">{error}</p><button className="button primary" onClick={() => location.reload()}><RefreshCw size={17} />重新连接</button></> : <Spinner label="正在连接同频…" />}</main>
      : roomId ? <RoomPage key={roomId} roomId={roomId} session={session} onHome={() => navigate('/')} />
      : <Home session={session} navigate={navigate} />}
  </div>
}
