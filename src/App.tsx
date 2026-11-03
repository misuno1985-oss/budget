import { useCallback, useEffect, useRef, useState } from 'react'
import { capital, month, prepaidLeft, tax } from './calc'
import { fetchComments, inboxNumber, loadData, loadSettings, saveData, saveSettings, type Settings } from './github'
import { cachedRates, fetchRates, type RatesInfo } from './rates'
import { applyOp, emptyState, ingest, uid, undoOp } from './state'
import type { Bank, State } from './types'
import { CUR_SIGN } from './types'
import { fmt, MoneyInput, Num, Rows } from './ui'

const LKEY = 'budget.state'
const TABS = ['Месяц', 'Капитал', 'Налоги', 'Квартира', 'Операции', 'Настройки'] as const
type Tab = (typeof TABS)[number]
const BANK_NAME: Record<Bank, string> = { pko: 'PKO', revolut: 'Revolut' }

function localState(): State {
  try {
    const s = JSON.parse(localStorage.getItem(LKEY) || 'null')
    if (s?.version === 1) return s
  } catch {}
  return emptyState()
}

const ruDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function App() {
  const [state, setState] = useState<State>(localState)
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('budget.tab') as Tab) || 'Месяц')
  const [rates, setRates] = useState<RatesInfo>(cachedRates)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [status, setStatus] = useState('')
  const [today, setToday] = useState(() => new Date())
  const sha = useRef<string | null>(null)
  const ready = useRef(false)
  const inbox = useRef<number | null>(null)
  const saving = useRef<Promise<void> | null>(null)
  const dirty = useRef(false)

  const upd = useCallback((f: (s: State) => void) => {
    setState(prev => {
      const next = structuredClone(prev)
      f(next)
      return next
    })
  }, [])

  const pullOps = useCallback(async () => {
    if (!settings.token) return
    try {
      inbox.current ??= await inboxNumber(settings)
      const comments = await fetchComments(settings, inbox.current)
      setState(prev => (comments.some(c => c.id > prev.lastCommentId) ? ingest(prev, comments, rates.rates) : prev))
    } catch {
      setStatus('Не удалось прочитать уведомления')
    }
  }, [settings, rates])

  // Старт: курсы, данные из закрытого репозитория, новые уведомления.
  useEffect(() => {
    fetchRates().then(setRates).catch(() => {})
    const t = setInterval(() => setToday(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    ready.current = false
    if (!settings.token) {
      ready.current = true
      setStatus('Только на этом устройстве — подключите GitHub в Настройках')
      return
    }
    setStatus('Загружаю…')
    loadData(settings)
      .then(({ state: s, sha: h }) => {
        sha.current = h
        ready.current = true
        if (s) {
          skip.current = true
          setState(s)
        } else setState(prev => ({ ...prev }))
        setStatus(s ? 'Загружено' : 'Новый файл данных')
        return pullOps()
      })
      .catch(e => setStatus(e.status === 401 ? 'Ключ GitHub не подходит' : e.status === 404 ? 'Репозиторий не найден' : 'Нет связи с GitHub'))
  }, [settings.token, settings.repo]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onFocus = () => pullOps()
    window.addEventListener('focus', onFocus)
    const t = setInterval(pullOps, 60_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(t)
    }
  }, [pullOps])

  // Сохранение: сразу в браузер, через 1,5 с — в GitHub.
  const skip = useRef(true)
  useEffect(() => {
    try {
      localStorage.setItem(LKEY, JSON.stringify(state))
    } catch {}
    if (skip.current) {
      skip.current = false
      return
    }
    if (!ready.current || !settings.token) return
    dirty.current = true
    const t = setTimeout(async () => {
      if (saving.current) await saving.current
      if (!dirty.current) return
      dirty.current = false
      setStatus('Сохраняю…')
      saving.current = saveData(settings, state, sha.current)
        .then(h => {
          sha.current = h
          setStatus(`Сохранено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)
        })
        .catch(() => {
          dirty.current = true
          setStatus('Не сохранилось — проверьте интернет')
        })
        .finally(() => (saving.current = null))
    }, 1500)
    return () => clearTimeout(t)
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      localStorage.setItem('budget.tab', tab)
    } catch {}
  }, [tab])

  const R = rates.rates
  const m = month(state, R, today)
  const c = capital(state, R, today)
  const t = tax(state)
  const unknown = state.ops.filter(o => o.status === 'unknown').length

  return (
    <div className="app">
      <header>
        <nav>
          {TABS.map(x => (
            <button key={x} className={x === tab ? 'tab on' : 'tab'} onClick={() => setTab(x)}>
              {x}
              {x === 'Операции' && unknown > 0 && <span className="badge">{unknown}</span>}
            </button>
          ))}
        </nav>
        <div className="rates">
          $ {fmt(R.USD, 4)} · € {fmt(R.EUR, 4)} · BYN {fmt(R.BYN, 4)} · ₽ {fmt(R.RUB, 4)}
          <span className="muted"> NBP {rates.date && rates.date.split('-').reverse().slice(0, 2).join('.')}</span>
        </div>
      </header>

      <section className="kpi">
        <div className="tile">
          <p>Остаток месяца</p>
          <b className={m.rest < 0 ? 'neg' : ''}>{fmt(m.rest)} zł</b>
        </div>
        <div className="tile pay">
          <p>Деньги придут</p>
          <input type="date" value={state.payday} onChange={e => upd(s => void (s.payday = e.target.value))} />
        </div>
        <div className="tile">
          <p>Дней осталось</p>
          <b>{state.payday ? Math.max(0, m.days) : '—'}</b>
        </div>
        <div className="tile">
          <p>Можно в день</p>
          <b className={m.perDay === null ? '' : m.perDay < 0 ? 'neg' : 'pos'}>{m.perDay === null ? 'выберите дату' : `${fmt(m.perDay)} zł`}</b>
        </div>
      </section>

      {tab === 'Месяц' && (
        <div className="grid">
          <div className="card">
            <h3>Доходы</h3>
            <Rows rows={state.incomes} rates={R} onChange={r => upd(s => void (s.incomes = r))} extra={r => <BankTag s={state} id={r.id} />} />
            <div className="star">
              <span>Взял из капитала*</span>
              <Num value={state.fromCapital} onChange={v => upd(s => void (s.fromCapital = v))} />
            </div>
            <div className="sum">
              <span>Всего</span>
              <b>{fmt(m.income)}</b>
            </div>
          </div>
          <div className="card">
            <h3>Расходы</h3>
            <Rows rows={state.expenses} rates={R} withPlan onChange={r => upd(s => void (s.expenses = r))} />
            <div className="star">
              <span>Подписки (осталось)</span>
              <b>{fmt(m.subs)}</b>
            </div>
            <div className="star">
              <span>Отложить в капитал*</span>
              <Num value={state.toCapital} onChange={v => upd(s => void (s.toCapital = v))} />
            </div>
            <div className="sum">
              <span>Всего</span>
              <b>{fmt(m.expense)}</b>
            </div>
            <p className="muted small">План в остаток не входит — впишите факт, когда заплатите.</p>
          </div>
          <div className="card wide">
            <h3>Подписки</h3>
            <table className="rows subs">
              <thead>
                <tr>
                  <th>Сервис</th>
                  <th>День</th>
                  <th className="r">Цена, zł</th>
                  <th>Оплачено</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.subs.map((x, i) => (
                  <tr key={x.id} className={x.paid ? 'paid' : ''}>
                    <td>
                      <input className="name" value={x.name} placeholder="Сервис" onChange={e => upd(s => void (s.subs[i].name = e.target.value))} />
                    </td>
                    <td>
                      <Num width={44} value={x.day} onChange={v => upd(s => void (s.subs[i].day = v))} />
                    </td>
                    <td className="r">
                      <Num width={80} value={x.price} onChange={v => upd(s => void (s.subs[i].price = v))} />
                    </td>
                    <td>
                      <input type="checkbox" checked={x.paid} onChange={e => upd(s => void (s.subs[i].paid = e.target.checked))} />
                    </td>
                    <td className="del">
                      <button className="x" aria-label="Удалить" onClick={() => confirm(`Удалить «${x.name}»?`) && upd(s => void s.subs.splice(i, 1))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-between">
              <button className="add" onClick={() => upd(s => void s.subs.push({ id: uid(), name: '', day: 1, price: 0, paid: false }))}>
                + подписка
              </button>
              <span>
                Все подписки: <b>{fmt(state.subs.reduce((a, x) => a + x.price, 0))}</b> · осталось списать: <b>{fmt(m.subs)}</b>
              </span>
            </div>
          </div>
        </div>
      )}

      {tab === 'Капитал' && (
        <div className="grid">
          <div className="card">
            <h3>Активы</h3>
            <Rows rows={state.assets} rates={R} live addLabel="+ актив" onChange={r => upd(s => void (s.assets = r))} extra={r => <BankTag s={state} id={r.id} />} />
            <div className="star">
              <span>Отложено из месяца*</span>
              <b>{fmt(state.toCapital)}</b>
            </div>
            <div className="sum">
              <span>Всего</span>
              <b>{fmt(c.assets)}</b>
            </div>
            <p className="muted small">Суммы в валюте здесь пересчитываются по сегодняшнему курсу.</p>
          </div>
          <div className="card">
            <h3>Долги и обязательства</h3>
            <Rows rows={state.liabilities} rates={R} addLabel="+ долг" onChange={r => upd(s => void (s.liabilities = r))} />
            <div className="star">
              <span>Налог {state.tax.year} (осталось)</span>
              <b>{fmt(c.taxLeft)}</b>
            </div>
            <div className="star">
              <span>Взял в месяц*</span>
              <b>{fmt(state.fromCapital)}</b>
            </div>
            <div className="sum">
              <span>Всего</span>
              <b>{fmt(c.debts)}</b>
            </div>
          </div>
          <div className="card wide total">
            <div className="row-between">
              <span>На руках</span>
              <b>{fmt(c.onHand)} zł</b>
            </div>
            <div className="row-between muted">
              <span>+ квартира оплачена вперёд</span>
              <span>{fmt(c.prepaid)} zł</span>
            </div>
            <div className="row-between big">
              <span>Итого</span>
              <b>{fmt(c.total)} zł</b>
            </div>
          </div>
        </div>
      )}

      {tab === 'Налоги' && (
        <div className="grid">
          <div className="card wide">
            <h3>
              Доходы {state.tax.year}{' '}
              <Num width={64} value={state.tax.year} onChange={v => upd(s => void (s.tax.year = v))} />
            </h3>
            <div className="taxcols">
              {state.tax.columns.map((col, ci) => (
                <div key={col.id} className="taxcol">
                  <input className="name strong" value={col.name} onChange={e => upd(s => void (s.tax.columns[ci].name = e.target.value))} />
                  <label className="muted small">
                    налог <Num width={48} value={col.rate} onChange={v => upd(s => void (s.tax.columns[ci].rate = v))} /> %
                  </label>
                  {col.items.map((it, ii) => (
                    <div key={it.id} className="taxitem">
                      <Num value={it.v} onChange={v => upd(s => void (s.tax.columns[ci].items[ii].v = v))} />
                      <button className="x" aria-label="Удалить" onClick={() => upd(s => void s.tax.columns[ci].items.splice(ii, 1))}>
                        ×
                      </button>
                    </div>
                  ))}
                  <button className="add" onClick={() => upd(s => void s.tax.columns[ci].items.push({ id: uid(), v: 0 }))}>
                    + доход
                  </button>
                  <div className="sum">
                    <span>Сумма</span>
                    <b>{fmt(t.cols[ci].income, 2)}</b>
                  </div>
                  <div className="star">
                    <span>Налог</span>
                    <b>{fmt(t.cols[ci].due, 2)}</b>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>Urząd Skarbowy — взносы</h3>
            <table className="rows">
              <tbody>
                {state.tax.payments.map((p, i) => (
                  <tr key={p.id}>
                    <td>
                      <input type="date" value={p.date} onChange={e => upd(s => void (s.tax.payments[i].date = e.target.value))} />
                    </td>
                    <td className="r">
                      <Num value={p.amount} onChange={v => upd(s => void (s.tax.payments[i].amount = v))} />
                    </td>
                    <td className="del">
                      <button className="x" aria-label="Удалить" onClick={() => confirm('Удалить взнос?') && upd(s => void s.tax.payments.splice(i, 1))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              className="add"
              onClick={() => upd(s => void s.tax.payments.push({ id: uid(), date: new Date().toISOString().slice(0, 10), amount: 0 }))}
            >
              + взнос
            </button>
          </div>
          <div className="card">
            <h3>Итог</h3>
            <div className="star">
              <span>Должен заплатить</span>
              <b>{fmt(t.due, 2)}</b>
            </div>
            <div className="star">
              <span>Уже заплатил</span>
              <b>{fmt(t.paid, 2)}</b>
            </div>
            <div className="sum big">
              <span>Осталось</span>
              <b className={t.left > 0 ? 'neg' : 'pos'}>{fmt(t.left, 2)}</b>
            </div>
            <p className="muted small">«Осталось» автоматически стоит в долгах капитала.</p>
          </div>
        </div>
      )}

      {tab === 'Квартира' && (
        <div className="grid">
          <div className="card">
            <h3>Оплата наперёд</h3>
            <div className="star">
              <span>Отдал деньги</span>
              <input type="date" value={state.prepaid.paidOn} onChange={e => upd(s => void (s.prepaid.paidOn = e.target.value))} />
            </div>
            <div className="star">
              <span>Оплачено до</span>
              <input type="date" value={state.prepaid.until} onChange={e => upd(s => void (s.prepaid.until = e.target.value))} />
            </div>
            <div className="star">
              <span>Сумма, zł</span>
              <Num value={state.prepaid.amount} onChange={v => upd(s => void (s.prepaid.amount = v))} />
            </div>
            <div className="sum big">
              <span>Сейчас идёт в капитал</span>
              <b>{fmt(prepaidLeft(state.prepaid, today))}</b>
            </div>
            <p className="muted small">Сумма делится поровну на оплаченные месяцы и уменьшается каждый месяц от даты оплаты.</p>
          </div>
          <div className="card wide">
            <h3>История оплат</h3>
            <table className="rows rent">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th className="r">Чынш</th>
                  <th className="r">Электр.</th>
                  <th className="r">Найм</th>
                  <th>Заметка</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.rent.map((p, i) => (
                  <tr key={p.id}>
                    <td>
                      <input type="date" value={p.date} onChange={e => upd(s => void (s.rent[i].date = e.target.value))} />
                    </td>
                    {(['chynsh', 'electr', 'rent'] as const).map(k => (
                      <td key={k} className="r">
                        <Num width={70} value={p[k]} onChange={v => upd(s => void (s.rent[i][k] = v))} />
                      </td>
                    ))}
                    <td>
                      <input className="name" value={p.note} onChange={e => upd(s => void (s.rent[i].note = e.target.value))} />
                    </td>
                    <td className="del">
                      <button className="x" aria-label="Удалить" onClick={() => confirm('Удалить запись?') && upd(s => void s.rent.splice(i, 1))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              className="add"
              onClick={() =>
                upd(s => void s.rent.unshift({ id: uid(), date: new Date().toISOString().slice(0, 10), chynsh: 0, electr: 0, rent: 0, note: '' }))
              }
            >
              + оплата
            </button>
          </div>
        </div>
      )}

      {tab === 'Операции' && (
        <div className="card">
          <div className="row-between">
            <h3>Уведомления банков</h3>
            <button className="add" onClick={pullOps}>
              Проверить сейчас
            </button>
          </div>
          {(['pko', 'revolut'] as Bank[]).map(b =>
            linkedName(state, b) ? null : (
              <p key={b} className="warn small">
                {BANK_NAME[b]} не привязан к счёту — выберите строку в Настройках, иначе суммы не будут меняться.
              </p>
            ),
          )}
          {state.ops.length === 0 && <p className="muted">Пока ничего не пришло.</p>}
          <table className="rows ops">
            <tbody>
              {state.ops.map((o, i) => (
                <tr key={o.id} className={o.status}>
                  <td className="muted nowrap">{ruDate(o.at)}</td>
                  <td className="nowrap">{BANK_NAME[o.bank]}</td>
                  <td className="optext">{o.text}</td>
                  <td className="r nowrap">
                    {o.amount === null ? '?' : `${o.status === 'applied' ? (o.dir > 0 ? '+' : '−') : ''}${fmt(o.amount, 2)} ${CUR_SIGN[o.cur]}`}
                  </td>
                  <td className="nowrap">
                    {o.status === 'applied' ? (
                      <button className="add" onClick={() => upd(s => undoOp(s, s.ops[i], R))}>
                        отменить
                      </button>
                    ) : o.status === 'unknown' ? (
                      <>
                        <button className="add" disabled={o.amount === null} onClick={() => upd(s => applyOp(s, s.ops[i], 1, R))}>
                          + пришло
                        </button>{' '}
                        <button className="add" disabled={o.amount === null} onClick={() => upd(s => applyOp(s, s.ops[i], -1, R))}>
                          − ушло
                        </button>{' '}
                        <button className="add" onClick={() => upd(s => void (s.ops[i].status = 'ignored'))}>
                          не считать
                        </button>
                      </>
                    ) : (
                      <button className="add" onClick={() => upd(s => void (s.ops[i].status = 'unknown'))}>
                        вернуть
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'Настройки' && <SettingsTab state={state} upd={upd} settings={settings} setSettings={setSettings} inbox={inbox.current} />}

      <footer className="muted small">{status}</footer>
    </div>
  )
}

function linkedName(s: State, b: Bank): string | null {
  const id = s.bankLinks[b]
  return [...s.incomes, ...s.assets].find(r => r.id === id)?.name || null
}

function BankTag({ s, id }: { s: State; id: string }) {
  const b = (Object.keys(s.bankLinks) as Bank[]).find(k => s.bankLinks[k] === id)
  return b ? <span className="tag" title="Меняется по уведомлениям банка">авто {BANK_NAME[b]}</span> : null
}

function SettingsTab({
  state,
  upd,
  settings,
  setSettings,
  inbox,
}: {
  state: State
  upd: (f: (s: State) => void) => void
  settings: Settings
  setSettings: (s: Settings) => void
  inbox: number | null
}) {
  const [token, setToken] = useState(settings.token)
  const [repo, setRepo] = useState(settings.repo)
  const rows = [...state.incomes.map(r => ({ ...r, g: 'Месяц' })), ...state.assets.map(r => ({ ...r, g: 'Капитал' }))]
  const url = inbox ? `https://api.github.com/repos/${settings.repo}/issues/${inbox}/comments` : '— появится после подключения —'
  return (
    <div className="grid">
      <div className="card">
        <h3>Хранение данных</h3>
        <label className="field">
          Закрытый репозиторий
          <input value={repo} onChange={e => setRepo(e.target.value.trim())} />
        </label>
        <label className="field">
          Ключ GitHub (вводится один раз на каждом устройстве)
          <input type="password" value={token} onChange={e => setToken(e.target.value.trim())} placeholder="github_pat_…" autoComplete="off" />
        </label>
        <button
          className="primary"
          onClick={() => {
            const s = { token, repo }
            saveSettings(s)
            setSettings(s)
          }}
        >
          Подключить
        </button>
        <p className="muted small">Ключ хранится только в этом браузере. Страница программы открыта всем, но без ключа в ней нет ваших данных.</p>
      </div>
      <div className="card">
        <h3>Какие счета меняют уведомления</h3>
        {(['pko', 'revolut'] as Bank[]).map(b => (
          <label key={b} className="field">
            {BANK_NAME[b]}
            <select value={state.bankLinks[b] ?? ''} onChange={e => upd(s => void (s.bankLinks[b] = e.target.value || null))}>
              <option value="">— не менять —</option>
              {rows.map(r => (
                <option key={r.id} value={r.id}>
                  {r.g}: {r.name || 'без названия'}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="card wide">
        <h3>Команда на iPhone</h3>
        <p className="small">В каждую Команду (PKO и Revolut) после шага «Добавить в файл» добавьте шаг «Получить содержимое URL»:</p>
        <ul className="small">
          <li>
            URL: <code>{url}</code>
          </li>
          <li>Метод: POST</li>
          <li>
            Заголовки: <code>Authorization</code> = <code>Bearer ваш_ключ</code>
          </li>
          <li>
            Текст запроса — JSON, поле <code>body</code> = <code>PKO: </code>
            <i>текст уведомления</i> (для второй Команды — <code>revolut: </code>…)
          </li>
        </ul>
      </div>
      <div className="card wide">
        <h3>Копия данных</h3>
        <button
          className="add"
          onClick={() => {
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }))
            a.download = `budget-${new Date().toISOString().slice(0, 10)}.json`
            a.click()
          }}
        >
          Скачать копию
        </button>
      </div>
    </div>
  )
}
