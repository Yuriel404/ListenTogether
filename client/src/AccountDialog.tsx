import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, LogOut, QrCode, RefreshCw, ShieldCheck } from 'lucide-react'
import type { RoomSnapshot } from '../../shared/types'
import { errorText, post, request } from './api'
import { Dialog, Spinner } from './ui'

export function AccountDialog({ room, onClose, notify }: { room: RoomSnapshot; onClose: () => void; notify: (message: string, error?: boolean) => void }) {
  const [qr, setQr] = useState<{ requestId: string; image: string } | null>(null)
  const [status, setStatus] = useState(801)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cookie, setCookie] = useState('')
  const base = `/api/rooms/${room.id}/account`
  const generate = async () => {
    setLoading(true); setError(''); setQr(null); setStatus(801)
    try { setQr(await post(`${base}/qr`)) } catch (err) { setError(errorText(err)) } finally { setLoading(false) }
  }
  useEffect(() => { if (!room.account.connected && room.account.mode === 'netease') void generate() }, [])
  useEffect(() => {
    if (!qr) return
    let active = true, timer: ReturnType<typeof setTimeout>, failures = 0
    const poll = async () => {
      try {
        const result = await post<{ status: number }>(`${base}/qr/${qr.requestId}/check`)
        if (!active) return
        failures = 0; setError(''); setStatus(result.status)
        if (result.status === 803) { notify('网易云账号已连接'); onClose(); return }
        if (result.status === 800) return
      } catch (err) {
        if (!active) return
        setError(errorText(err)); failures++
        if (failures >= 3) { setStatus(800); return }
      }
      if (active) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 1800)
    return () => { active = false; clearTimeout(timer) }
  }, [qr?.requestId])
  const connectDemo = async () => {
    setLoading(true); setError('')
    try { await post(`${base}/demo`); notify('已连接本地演示音源'); onClose() }
    catch (err) { setError(errorText(err)) } finally { setLoading(false) }
  }
  const connectCookie = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try { await post(`${base}/cookie`, { cookie }); notify('网易云账号已连接'); onClose() }
    catch (err) { setError(errorText(err)) } finally { setCookie(''); setLoading(false) }
  }
  const disconnect = async () => {
    setLoading(true); setError('')
    try { await request(base, { method: 'DELETE' }); notify('账号已断开，房间播放已暂停'); onClose() }
    catch (err) { setError(errorText(err)) } finally { setLoading(false) }
  }
  return <Dialog title={room.account.mode === 'demo' ? '连接演示音源' : '连接网易云音乐'} onClose={onClose}>
    {room.account.connected ? <div className="account-connected"><span className="connected-icon"><CheckCircle2 size={36} /></span><h3>{room.account.nickname}</h3><p>{room.account.mode === 'demo' ? '本地生成的演示旋律已就绪' : `账号已连接 · ${room.account.vipType ? '会员账号' : '普通账号'}`}</p><button className="button secondary full" onClick={() => void disconnect()} disabled={loading}><LogOut size={17} />断开当前账号</button></div>
      : room.account.mode === 'demo' ? <div className="demo-connect"><span className="connected-icon"><QrCode size={35} /></span><h3>先感受一下同频</h3><p>播放本地合成的旋律，体验点歌、聊天与多人同步。演示模式无需网易云账号。</p><button className="button primary full" onClick={() => void connectDemo()} disabled={loading}>{loading ? <Spinner label="连接中…" /> : '连接演示音源'}</button></div>
      : <><p className="dialog-description">使用网易云音乐 App 扫码，并在手机上确认登录。</p><div className="qr-area">{loading && !qr ? <Spinner label="正在生成二维码…" /> : qr ? <img src={qr.image} alt="网易云音乐登录二维码" /> : <QrCode size={62} className="muted" />}{status === 800 && qr && <div className="qr-expired">二维码已过期</div>}</div><p className="qr-status">{status === 802 ? '已扫码，请在手机上确认登录' : status === 803 ? '登录成功' : status === 800 ? '请刷新二维码后重试' : '等待房主扫码'}</p><button className="button secondary full" disabled={loading} onClick={() => void generate()}><RefreshCw size={16} />刷新二维码</button><details className="manual-login"><summary>已有登录 Cookie？手动连接</summary><form className="form-stack" onSubmit={connectCookie}><label>网易云 Cookie<input type="password" autoComplete="off" value={cookie} onChange={(e) => setCookie(e.target.value)} maxLength={8000} placeholder="包含 MUSIC_U 的登录 Cookie" required /></label><button className="button secondary full" disabled={loading}>验证并连接</button></form></details></>}
    {error && <p className="error-text" role="alert">{error}</p>}<div className="account-note"><ShieldCheck size={18} /><span>登录凭据加密保存在服务端，仅用于本房间解析音乐。成员不会收到你的 Cookie。</span></div>
  </Dialog>
}
