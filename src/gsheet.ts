/**
 * Создание Google-таблицы в Диске пользователя. Вход — Google Identity Services (всплывающее окно Google),
 * доступ только drive.file: программа видит лишь те файлы, которые сама создала, — остальной Диск ей недоступен.
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
let gis: Promise<void> | null = null

function loadGis(): Promise<void> {
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve()
  gis ??= new Promise((ok, fail) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => ok()
    s.onerror = () => {
      gis = null
      fail(new Error('Не удалось загрузить вход Google'))
    }
    document.head.appendChild(s)
  })
  return gis
}

let cached: { token: string; until: number } | null = null

/** Токен доступа; окно Google открывается только при первом входе (и когда токен истёк через час). */
export async function googleToken(clientId: string): Promise<string> {
  if (cached && cached.until > Date.now() + 6e4) return cached.token
  await loadGis()
  return new Promise((ok, fail) => {
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r: any) => {
        if (r.error || !r.access_token) return fail(new Error(r.error_description || r.error || 'Вход в Google отменён'))
        cached = { token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 }
        ok(r.access_token)
      },
      error_callback: (e: any) => fail(new Error(e?.type === 'popup_closed' ? 'Окно Google закрыто' : e?.message || 'Вход в Google не удался')),
    })
    client.requestAccessToken({ prompt: cached ? '' : 'consent' })
  })
}

export async function createSpreadsheet(token: string, body: unknown): Promise<string> {
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 401) cached = null
    throw new Error(j?.error?.message || `Google ответил ${r.status}`)
  }
  return j.spreadsheetUrl as string
}
