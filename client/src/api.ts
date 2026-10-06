import type { SessionInfo } from '../../shared/types'

let csrfToken = ''
let bootstrap: Promise<SessionInfo> | undefined

export function initializeSession(): Promise<SessionInfo> {
  bootstrap ??= request<SessionInfo>('/api/session').then((session) => {
    csrfToken = session.csrfToken
    return session
  }).catch((error) => { bootstrap = undefined; throw error })
  return bootstrap
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (options.method && !['GET', 'HEAD'].includes(options.method)) headers.set('x-csrf-token', csrfToken)
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试')
  return data as T
}

export function post<T>(path: string, data: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(data) })
}

export function savedNickname(): string {
  try { return localStorage.getItem('listen_nickname') || '' } catch { return '' }
}
export function saveNickname(nickname: string): void {
  try { localStorage.setItem('listen_nickname', nickname) } catch { /* 私密模式仍可使用当前会话。 */ }
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试'
