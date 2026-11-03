import type { Comment } from './state'
import type { State } from './types'

export interface Settings {
  token: string
  repo: string // владелец/имя закрытого репозитория с данными
}

const SKEY = 'budget.settings'
export const INBOX_TITLE = 'Уведомления банков'

export function loadSettings(): Settings {
  try {
    return { token: '', repo: 'misuno1985-oss/budget-data', ...JSON.parse(localStorage.getItem(SKEY) || '{}') }
  } catch {
    return { token: '', repo: 'misuno1985-oss/budget-data' }
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SKEY, JSON.stringify(s))
  } catch {}
}

async function api(st: Settings, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.github.com/repos/${st.repo}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${st.token}`,
      Accept: 'application/vnd.github+json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!r.ok) {
    const e = new Error(`GitHub ${r.status}`) as Error & { status: number }
    e.status = r.status
    throw e
  }
  return r.status === 204 ? null : r.json()
}

const b64decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)))
const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach(b => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

export async function loadData(st: Settings): Promise<{ state: State | null; sha: string | null }> {
  try {
    const f = await api(st, '/contents/data.json')
    return { state: JSON.parse(b64decode(f.content)), sha: f.sha }
  } catch (e: any) {
    if (e.status === 404) return { state: null, sha: null }
    throw e
  }
}

export async function saveData(st: Settings, state: State, sha: string | null): Promise<string> {
  const body = (s: string | null) =>
    JSON.stringify({
      message: `Сохранение ${new Date().toLocaleString('ru-RU')}`,
      content: b64encode(JSON.stringify(state, null, 1)),
      ...(s ? { sha: s } : {}),
    })
  try {
    const r = await api(st, '/contents/data.json', { method: 'PUT', body: body(sha) })
    return r.content.sha
  } catch (e: any) {
    // Файл менялся с другого устройства: последнее сохранение побеждает.
    if (e.status !== 409 && e.status !== 422) throw e
    const fresh = await loadData(st)
    const r = await api(st, '/contents/data.json', { method: 'PUT', body: body(fresh.sha) })
    return r.content.sha
  }
}

/** Номер задачи-«почтового ящика», куда Команда с iPhone пишет уведомления комментариями. */
export async function inboxNumber(st: Settings): Promise<number> {
  const list = await api(st, '/issues?state=all&per_page=100')
  const found = list.find((i: any) => i.title === INBOX_TITLE)
  if (found) return found.number
  const created = await api(st, '/issues', {
    method: 'POST',
    body: JSON.stringify({ title: INBOX_TITLE, body: 'Сюда Команды с iPhone присылают уведомления PKO и Revolut.' }),
  })
  return created.number
}

export async function fetchComments(st: Settings, issue: number): Promise<Comment[]> {
  const all: Comment[] = []
  for (let page = 1; page < 50; page++) {
    const part = await api(st, `/issues/${issue}/comments?per_page=100&page=${page}`)
    all.push(...part.map((c: any) => ({ id: c.id, created_at: c.created_at, body: c.body })))
    if (part.length < 100) break
  }
  return all
}
