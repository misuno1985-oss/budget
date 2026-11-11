import { useCallback, useEffect, useRef, useState } from 'react'
import { capital, dm, itemPln, month, nextDue, parseDate, prepaidLeft, subOrder, subPln, tax } from './calc'
import { loadBank, loadData, triggerBank, loadSettings, saveData, saveSettings, type Settings } from './github'
import { cachedRates, fetchRates, nbpRateBefore, type RatesInfo } from './rates'
import { bookedLabel } from './autobook'
import { brandsOf, KAS_LOGO } from './brands'
import { Background } from './Background'
import { mainAccount, reconcile, sessionDaysLeft, txLabel } from './bank'
import { addManual, applyOp, emptyState, findAutoTwin, migrate, removeManual, setPayday, uid, undoNewCycle, undoOp, unmatch } from './state'
import type { Bank, BankFeed, Op, Rates, State, TaxItem } from './types'
import { CUR_SIGN } from './types'
import { buildGrid, sheetBody } from './sheet'
import { createSpreadsheet, googleToken } from './gsheet'
import { fmt, Logos, MoneyInput, Num, Rows, Txt } from './ui'

const LKEY = 'budget.state'
const TABS = ['Месяц', 'Капитал', 'Налоги', 'Покер', 'Квартира', 'Операции', 'Дочка', 'Настройки'] as const
type Tab = (typeof TABS)[number]
const BANK_NAME: Record<Bank, string> = { pko: 'PKO', revolut: 'Revolut' }

function localState(): State {
  try {
    const s = JSON.parse(localStorage.getItem(LKEY) || 'null')
    if (s?.version === 1 || s?.version === 2) return migrate(s)
  } catch {}
  return emptyState()
}

const BKEY = 'budget.bank'
function cachedFeed(): BankFeed | null {
  try {
    return JSON.parse(localStorage.getItem(BKEY) || 'null')
  } catch {
    return null
  }
}
const ruDay = (d: string) => d.slice(0, 10).split('-').reverse().join('.')

const ruDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function App() {
  const [state, setState] = useState<State>(localState)
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('budget.tab') as Tab) || 'Месяц')
  const [rates, setRates] = useState<RatesInfo>(cachedRates)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [status, setStatus] = useState('')
  const [today, setToday] = useState(() => new Date())
  const [feed, setFeed] = useState<BankFeed | null>(cachedFeed)
  const [refreshing, setRefreshing] = useState('')
  // Телефон — только «Обновить из банка» и «Можно в день»; полная программа — на компьютере.
  const [isPhone, setIsPhone] = useState(() => matchMedia('(max-width: 760px)').matches)
  const [phoneSettings, setPhoneSettings] = useState(false)
  useEffect(() => {
    const q = matchMedia('(max-width: 760px)')
    const on = () => setIsPhone(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  const sha = useRef<string | null>(null)
  const ready = useRef(false)
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
    // Данные поменяли на другом устройстве (или вручную) — подхватить, если здесь нет несохранённых правок.
    // Иначе это устройство при следующем сохранении записало бы поверх старое.
    if (ready.current && !dirty.current && !saving.current) {
      try {
        const { state: remote, sha: h } = await loadData(settings)
        if (remote && h && h !== sha.current && !dirty.current && !saving.current) {
          sha.current = h
          skip.current = true
          setState(migrate(remote))
        }
      } catch {}
    }
    // Уведомления с телефона больше не читаем: остаток и операции берутся только из выписки банка.
    try {
      const f = await loadBank(settings)
      if (f) applyFeed(f)
      return f
    } catch {
      setStatus('Не удалось прочитать выписку банка')
      return null
    }
  }, [settings, rates]) // eslint-disable-line react-hooks/exhaustive-deps

  function applyFeed(f: BankFeed) {
    setFeed(f)
    try {
      localStorage.setItem(BKEY, JSON.stringify(f))
    } catch {}
    setState(prev => reconcile(prev, f, rates.rates))
  }

  /** Забрать выписку прямо сейчас: GitHub запускает сбор, ждём новый bank.json (обычно 30–60 с). */
  const refreshBank = useCallback(
    async (auto = false) => {
      if (!settings.token || refreshingRef.current) return
      refreshingRef.current = true
      try {
        localStorage.setItem('budget.bankAsked', String(Date.now()))
      } catch {}
      const before = feedRef.current?.fetchedAt ?? ''
      setRefreshing(auto ? 'Обновляю выписку банка…' : 'Запрашиваю банк…')
      try {
        await triggerBank(settings)
        setRefreshing('Банк отвечает… обычно до минуты')
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 8000))
          const f = await loadBank(settings).catch(() => null)
          if (f && f.fetchedAt !== before) {
            applyFeed(f)
            setRefreshing('')
            setStatus(`Выписка обновлена ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)
            return
          }
        }
        setRefreshing('')
        setStatus('Банк не ответил за 4 минуты — попробуйте позже')
      } catch (e: any) {
        setRefreshing('')
        setStatus(e.status === 403 || e.status === 404 ? 'Ключу GitHub не хватает разрешения Actions — см. Настройки' : 'Не удалось запросить банк')
      } finally {
        refreshingRef.current = false
      }
    },
    [settings, rates], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const refreshingRef = useRef(false)
  const feedRef = useRef(feed)
  feedRef.current = feed

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
          const m = migrate(s)
          // Старый формат — сразу сохранить обновлённый.
          if (m === s) skip.current = true
          setState(m)
        } else setState(prev => ({ ...prev }))
        setStatus(s ? 'Загружено' : 'Новый файл данных')
        return pullOps().then(autoRefresh)
      })
      .catch(e => setStatus(e.status === 401 ? 'Ключ GitHub не подходит' : e.status === 404 ? 'Репозиторий не найден' : 'Нет связи с GitHub'))
  }, [settings.token, settings.repo]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Выписка старше 15 минут — при открытии программы (или возврате в неё) обновить; не чаще раза в 5 минут. */
  function autoRefresh(f?: BankFeed | null) {
    let asked = 0
    try {
      asked = Number(localStorage.getItem('budget.bankAsked') || 0)
    } catch {}
    const old = !f || Date.now() - Date.parse(f.fetchedAt) > 15 * 6e4
    if (old && Date.now() - asked > 5 * 6e4) refreshBank(true)
  }

  useEffect(() => {
    const onFocus = () => pullOps().then(f => ready.current && autoRefresh(f))
    const onShow = () => document.visibilityState === 'visible' && onFocus()
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onFocus)
    const t = setInterval(pullOps, 60_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onShow)
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
    document.querySelector('nav .tab.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [tab])

  const R = rates.rates
  const m = month(state, R, today)
  const c = capital(state, R, today)
  const t = tax(state)
  const unknown = state.ops.filter(o => o.status === 'unknown').length
  const expiring = sessionDaysLeft(feed).filter(x => x.days < 14)
  const staleHours = feed ? Math.floor((today.getTime() - Date.parse(feed.fetchedAt)) / 36e5) : 0

  // Валютные доходы без курса (добавлены из уведомления) — подтянуть курс NBP за день до, чтобы налог считался сразу.
  const fetching = useRef(new Set<string>())
  useEffect(() => {
    for (const col of state.tax.columns)
      for (const it of col.items) {
        if (!it.cur || it.cur === 'PLN' || it.rate || !it.date || fetching.current.has(it.id)) continue
        fetching.current.add(it.id)
        nbpRateBefore(it.cur, it.date).then(r => {
          if (r) upd(s => s.tax.columns.forEach(c => c.items.forEach(x => x.id === it.id && Object.assign(x, { rate: r.rate, rateDay: r.day }))))
        })
      }
  }, [state.tax.columns, upd])

  if (isPhone)
    return (
      <div className="app phone">
        <Background tab="Месяц" />
        {settings.token && !phoneSettings ? (
          <div className="phonecard">
            <button className="add phonebtn" disabled={!!refreshing} onClick={() => refreshBank(false)}>
              {refreshing ? <span className="spin">⟳</span> : '⟳'} {refreshing || 'Обновить из банка'}
            </button>
            <p className="phonelabel">Можно в день</p>
            <b className={'phonesum ' + (m.perDay === null ? '' : m.perDay < 0 ? 'neg' : 'pos')}>{m.perDay === null ? '—' : `${fmt(m.perDay)} zł`}</b>
          </div>
        ) : (
          <>
            {!settings.token && !phoneSettings && (
              <div className="phonecard">
                <p className="phonelabel">Нет ключа GitHub</p>
              </div>
            )}
            {phoneSettings && <SettingsTab state={state} upd={upd} settings={settings} setSettings={s => (setSettings(s), setPhoneSettings(false))} />}
            <button className="link phonelink" onClick={() => setPhoneSettings(!phoneSettings)}>
              {phoneSettings ? 'Закрыть' : 'Настройки'}
            </button>
          </>
        )}
      </div>
    )

  return (
    <div className="app">
      <Background tab={tab} />
      <header>
        <nav>
          {TABS.map(x => (
            <button key={x} className={x === tab ? 'tab on' : 'tab'} onClick={() => setTab(x)}>
              {x}
              {x === 'Операции' && unknown > 0 && <span className="badge">{unknown}</span>}
            </button>
          ))}
        </nav>
        <SheetButton state={state} rates={R} today={today} settings={settings} openSettings={() => setTab('Настройки')} />
        <div className="rates">
          $ {fmt(R.USD, 4)} · € {fmt(R.EUR, 4)}
          <span className="muted"> NBP {rates.date && rates.date.split('-').reverse().slice(0, 2).join('.')}</span>
        </div>
      </header>

      {settings.token && feed && staleHours >= 24 && (
        <p className="warn small banner">
          Выписка банка не обновлялась {staleHours >= 48 ? `${Math.floor(staleHours / 24)} дн.` : 'больше суток'} — остатки могут быть устаревшими. Нажмите «Обновить из банка»; не помогает — напишите Claude.
        </p>
      )}
      {expiring.map(x => (
        <p key={x.bank} className="warn small banner">
          {x.days < 0
            ? `Доступ к ${BANK_NAME[x.bank as Bank] ?? x.bank} закончился — выписка не обновляется. Нужно заново войти в банк.`
            : `Доступ к ${BANK_NAME[x.bank as Bank] ?? x.bank} закончится через ${x.days} дн. — нужно будет заново войти в банк.`}
        </p>
      ))}

      <section className="kpi">
        <div className="tile">
          <p>Остаток месяца</p>
          <b className={m.rest < 0 ? 'neg' : ''}>{fmt(m.rest)} zł</b>
        </div>
        <div className="tile pay">
          <p>Деньги придут</p>
          <label className="datebtn">
            {state.payday ? parseDate(state.payday).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }) : 'выбрать дату'}
            <input type="date" value={state.payday} onChange={e => upd(s => setPayday(s, e.target.value))} />
          </label>
          {state.lastCycle && Date.now() - Date.parse(state.lastCycle.at) < 864e5 && (
            <button className="link" onClick={() => upd(undoNewCycle)} title="Вернуть факт расходов и галочки подписок как было">
              новый месяц начат · вернуть
            </button>
          )}
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

      {tab === 'Месяц' && settings.token && (
        <div className="card slim">
          <BankLine feed={feed} refreshing={refreshing} onRefresh={() => refreshBank()} canRefresh />
        </div>
      )}

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
            <SubsList state={state} upd={upd} rates={R} today={today} />
            <table className="rows subs desk">
              <thead>
                <tr>
                  <th>Сервис</th>
                  <th>День</th>
                  <th>Следующий</th>
                  <th className="r">Цена, zł</th>
                  <th>Оплачено</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {subOrder(state, today).map(i => [state.subs[i], i] as const).map(([x, i]) => (
                  <tr key={x.id} className={x.paid ? 'paid' : ''}>
                    <td>
                      <div className="nmcell">
                        <Logos name={x.name} />
                        <Txt value={x.name} placeholder="Сервис" onChange={v => upd(s => void (s.subs[i].name = v))} />
                      </div>
                    </td>
                    <td>
                      <Num width={44} money={false} value={x.day} onChange={v => upd(s => void (s.subs[i].day = v))} />
                    </td>
                    <td className="nowrap">
                      <DueLabel x={x} state={state} today={today} />
                    </td>
                    <td className="r">
                      <MoneyInput
                        m={{ v: x.price, cur: x.cur ?? 'PLN' }}
                        rates={R}
                        live
                        onChange={mo => upd(s => void Object.assign(s.subs[i], { price: mo.v, cur: mo.cur === 'PLN' ? undefined : mo.cur }))}
                      />
                      {x.partial && !x.paid && (x.paidAmt ?? 0) > 0 && (
                        <div className="conv">
                          оплачено {fmt(x.paidAmt ?? 0)} из {fmt(subPln(x, R))}
                        </div>
                      )}
                    </td>
                    <td>
                      <input type="checkbox" className="chk" checked={x.paid} onChange={e =>
                          upd(s => {
                            s.subs[i].paid = e.target.checked
                            // Сняли галочку — новый месяц, частичные оплаты обнуляются.
                            if (!e.target.checked) s.subs[i].paidAmt = 0
                          })
                        }
                      />
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
                Все подписки: <b>{fmt(state.subs.reduce((a, x) => a + subPln(x, R), 0))}</b> · осталось списать: <b>{fmt(m.subs)}</b>
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
              <span className="nmcell">
                <img className="kas" src={KAS_LOGO} alt="" />
                Налог {state.tax.year} (осталось)
              </span>
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
              <img className="kas" src={KAS_LOGO} alt="" />
              Доходы <Num width={64} money={false} value={state.tax.year} onChange={v => upd(s => void (s.tax.year = v))} /> · Urząd Skarbowy
            </h3>
            <div className="taxcols">
              {state.tax.columns.map((col, ci) => {
                const brand = brandsOf(col.name)[0]
                return (
                  <div
                    key={col.id}
                    className={'taxcol' + (brand?.color ? ' branded' : '')}
                    style={brand?.color ? ({ '--brand': brand.color, '--on-brand': brand.key === 'bmc' ? '#000' : '#fff' } as React.CSSProperties) : undefined}
                  >
                    <div className="taxhead">
                      {brand && <img src={brand.src} alt="" />}
                      <Txt className="name strong" value={col.name} onChange={v => upd(s => void (s.tax.columns[ci].name = v))} />
                    </div>
                    <div className="taxline muted">
                      <span>налог</span>
                      <span>
                        <Num width={52} money={false} value={col.rate} onChange={v => upd(s => void (s.tax.columns[ci].rate = v))} /> %
                      </span>
                    </div>
                    {[...col.items]
                      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
                      .map(it => (
                        <TaxItemRow
                          key={it.id}
                          it={it}
                          rates={R}
                          onChange={patch => upd(s => void Object.assign(s.tax.columns[ci].items.find(x => x.id === it.id)!, patch))}
                          onDelete={() => confirm('Удалить поступление?') && upd(s => void (s.tax.columns[ci].items = s.tax.columns[ci].items.filter(x => x.id !== it.id)))}
                        />
                      ))}
                    <button className="add" onClick={() => upd(s => void s.tax.columns[ci].items.push({ id: uid(), v: 0, date: new Date().toISOString().slice(0, 10) }))}>
                      + доход
                    </button>
                    <div className="taxline total">
                      <span>Сумма</span>
                      <b>{fmt(t.cols[ci].income, 2)}</b>
                    </div>
                    <div className="band">
                      <span>Налог</span>
                      <b>{fmt(t.cols[ci].due, 2)}</b>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="card">
            <h3>
              <img className="kas" src={KAS_LOGO} alt="" />
              Urząd Skarbowy — взносы
            </h3>
            <table className="rows">
              <tbody>
                {state.tax.payments.map((p, i) => (
                  <tr key={p.id}>
                    <td>
                      <input type="date" value={p.date} onChange={e => upd(s => void (s.tax.payments[i].date = e.target.value))} />
                      {p.auto && <span className="tag">авто</span>}
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

      {tab === 'Покер' && (
        <div className="grid">
          <div className="card wide">
            <h3>♠ Покер · без налога</h3>
            <table className="rows">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Название</th>
                  <th className="r">Сумма, zł</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.poker.map((p, i) => (
                  <tr key={p.id}>
                    <td>
                      <input type="date" value={p.date} onChange={e => upd(s => void (s.poker[i].date = e.target.value))} />
                    </td>
                    <td>
                      <Txt value={p.name} placeholder="Выигрыш" onChange={v => upd(s => void (s.poker[i].name = v))} />
                    </td>
                    <td className="r">
                      <Num value={p.amount} onChange={v => upd(s => void (s.poker[i].amount = v))} />
                    </td>
                    <td className="del">
                      <button className="x" aria-label="Удалить" onClick={() => confirm('Удалить запись?') && upd(s => void s.poker.splice(i, 1))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="add" onClick={() => upd(s => void s.poker.push({ id: uid(), date: new Date().toISOString().slice(0, 10), name: '', amount: 0 }))}>
              + строка
            </button>
            <div className="sum big">
              <span>Всего</span>
              <b>{fmt(state.poker.reduce((a, p) => a + p.amount, 0), 2)} zł</b>
            </div>
            <p className="muted small">С покера налог не считается, в налоги эти суммы не попадают.</p>
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
            <div className="mob">
              {state.rent.map((p, i) => (
                <RentCard key={p.id} p={p} i={i} upd={upd} />
              ))}
            </div>
            <table className="rows rent desk">
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
                      {p.auto && <span className="tag">авто</span>}
                    </td>
                    {(['chynsh', 'electr', 'rent'] as const).map(k => (
                      <td key={k} className="r">
                        <Num width={70} value={p[k]} onChange={v => upd(s => void (s.rent[i][k] = v))} />
                      </td>
                    ))}
                    <td>
                      <Txt value={p.note} onChange={v => upd(s => void (s.rent[i].note = v))} />
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
            <h3>Операции</h3>
          </div>
          {(['pko', 'revolut'] as Bank[]).map(b =>
            linkedName(state, b) ? null : (
              <p key={b} className="warn small">
                {BANK_NAME[b]} не привязан к счёту — выберите строку в Настройках, иначе суммы не будут меняться.
              </p>
            ),
          )}
          <BankLine feed={feed} refreshing={refreshing} onRefresh={() => refreshBank()} canRefresh={!!settings.token} />
          <ManualForm state={state} upd={upd} rates={R} />
          {state.ops.length === 0 && <p className="muted">Пока ничего не пришло.</p>}
          <table className="rows ops">
            <tbody>
              {state.ops.map((o, i) => (
                <tr key={o.id} className={o.status}>
                  <td className="muted nowrap">{ruDate(o.at)}</td>
                  <td className="nowrap">
                    <span className="nmcell">
                      <Logos name={BANK_NAME[o.bank]} />
                      {BANK_NAME[o.bank]}
                    </span>
                  </td>
                  <td className="optext">
                    {o.manual && <span className="tag">вручную</span>}
                    {o.fromBank && <span className="tag bank">из банка</span>}
                    {o.bankPending && <span className="tag">в обработке</span>} {o.manual ? o.note || '' : o.fromBank ? txLabel(o.text) : o.text}
                    {o.status === 'matched' &&
                      (state.ops.find(x => x.id === o.matchedWith)?.fromBank ? (
                        <div className="matchnote">Уже учтено по выписке банка — второй раз не учтено</div>
                      ) : (
                        <div className="matchnote">Совпало с ручной записью — второй раз не учтено</div>
                      ))}
                    {!o.fromBank && o.bankTx && !o.bankPending && <div className="matchnote">✓ Есть в выписке банка</div>}
                    {o.manual && o.matchedWith && <div className="matchnote">Подтверждено уведомлением банка</div>}
                    {bookedLabel(state, o) && <div className="matchnote">{bookedLabel(state, o)}</div>}
                    {o.subId && <div className="matchnote">✓ Подписка «{state.subs.find(x => x.id === o.subId)?.name ?? '—'}» отмечена оплаченной</div>}
                  </td>
                  <td className="r nowrap">
                    {o.amount === null ? '?' : `${o.status === 'applied' || o.status === 'matched' ? (o.dir > 0 ? '+' : '−') : ''}${fmt(o.amount, 2)} ${CUR_SIGN[o.cur]}`}
                  </td>
                  <td className="nowrap">
                    {o.manual ? (
                      <button className="add" onClick={() => confirm('Удалить ручную запись? Сумма вернётся на счёт.') && upd(s => removeManual(s, o.id, R))}>
                        удалить
                      </button>
                    ) : o.status === 'matched' ? (
                      <button className="add" onClick={() => confirm('Это другие деньги? Тогда операция будет учтена отдельно.') && upd(s => unmatch(s, o.id, R))}>
                        это другие деньги
                      </button>
                    ) : o.status === 'applied' ? (
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
                        </button>{' '}
                        <DropOp id={o.id} upd={upd} />
                      </>
                    ) : (
                      <>
                        <button className="add" onClick={() => upd(s => void (s.ops[i].status = 'unknown'))}>
                          вернуть
                        </button>{' '}
                        <DropOp id={o.id} upd={upd} />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'Дочка' && <DaughterTab feed={feed} />}

      {tab === 'Настройки' && <SettingsTab state={state} upd={upd} settings={settings} setSettings={setSettings} />}

      <footer className="small">{status}</footer>
    </div>
  )
}

/**
 * Поступление дохода: дата и сумма как пришла на счёт. Двойной клик по сумме — валюта;
 * для валюты курс NBP за последний рабочий день перед датой подтягивается сам.
 */
function TaxItemRow({ it, rates, onChange, onDelete }: { it: TaxItem; rates: Rates; onChange: (p: Partial<TaxItem>) => void; onDelete: () => void }) {
  const cur = it.cur ?? 'PLN'
  const refresh = (c: TaxItem['cur'], date?: string) => {
    if (!c || c === 'PLN' || !date) return
    nbpRateBefore(c, date).then(r => r && onChange({ rate: r.rate, rateDay: r.day }))
  }
  // Курса ещё нет (вписали вручную или данные старые) — подтянуть.
  useEffect(() => {
    if (cur !== 'PLN' && !it.rate) refresh(it.cur, it.date)
  }, [it.cur, it.date, it.rate]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="taxitem2">
      <div className="taxline">
        <input type="date" value={it.date ?? ''} onChange={e => (onChange({ date: e.target.value }), refresh(cur, e.target.value))} />
        <MoneyInput
          m={{ v: it.v, cur }}
          rates={rates}
          live
          onChange={mo => {
            const c = mo.cur === 'PLN' ? undefined : mo.cur
            onChange({ v: mo.v, cur: c, ...(c ? {} : { rate: undefined, rateDay: undefined }) })
            if (c !== it.cur) refresh(c, it.date)
          }}
        />
        <button className="x" aria-label="Удалить" onClick={onDelete}>
          ×
        </button>
      </div>
      {it.auto && <div className="taxrate">авто, из банка</div>}
      {cur !== 'PLN' && (
        <div className="taxrate">
          {it.rate ? `курс NBP ${fmt(it.rate, 4)} (${(it.rateDay ?? '').split('-').reverse().join('.')}) = ${fmt(itemPln(it))} zł` : 'курс NBP загружается…'}
        </div>
      )}
    </div>
  )
}

/** Ручная запись операции (наличные и то, чего нет в банке). Вносится по «Ввод». */
function ManualForm({ state, upd, rates }: { state: State; upd: (f: (s: State) => void) => void; rates: Rates }) {
  const [bank, setBank] = useState<Bank>('revolut')
  const [dir, setDir] = useState<1 | -1>(-1)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const submit = () => {
    const v = Math.round(Number(amount.replace(/[\s\u00a0]/g, '').replace(',', '.')) * 100) / 100
    if (!(v > 0)) return
    const probe: Op = { id: 0, at: new Date().toISOString(), bank, text: '', amount: v, cur: 'PLN', dir, status: 'unknown' }
    const twin = findAutoTwin(state, probe)
    if (twin && !confirm(`Похожая операция уже пришла от банка ${ruDate(twin.at)}: ${dir > 0 ? '+' : '−'}${fmt(v)} zł. Всё равно внести вручную?`)) return
    upd(s => void addManual(s, bank, dir, v, note.trim(), rates))
    setAmount('')
    setNote('')
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="manual">
      <b>+ операция вручную</b>
      <select value={bank} onChange={e => setBank(e.target.value as Bank)}>
        <option value="revolut">Revolut</option>
        <option value="pko">PKO</option>
      </select>
      <span className="seg">
        <button className={dir < 0 ? 'on' : ''} onClick={() => setDir(-1)}>
          − ушло
        </button>
        <button className={dir > 0 ? 'on' : ''} onClick={() => setDir(1)}>
          + пришло
        </button>
      </span>
      <input className={'num' + (amount ? ' pending' : '')} placeholder="0,00" value={amount} enterKeyHint="enter" onChange={e => setAmount(e.target.value)} onKeyDown={onKey} />
      <input className="note" placeholder="заметка (жене, Żabka…)" value={note} enterKeyHint="enter" onChange={e => setNote(e.target.value)} onKeyDown={onKey} />
      <span className="muted small">↵ Ввод — внести. Когда та же операция придёт из банка, второй раз она не посчитается.</span>
    </div>
  )
}

function linkedName(s: State, b: Bank): string | null {
  const id = s.bankLinks[b]
  return [...s.incomes, ...s.assets].find(r => r.id === id)?.name || null
}

function BankTag({ s, id }: { s: State; id: string }) {
  const b = (Object.keys(s.bankLinks) as Bank[]).find(k => s.bankLinks[k] === id)
  return b ? <span className="tag" title="Остаток берётся из выписки банка">авто {BANK_NAME[b]}</span> : null
}

function SettingsTab({
  state,
  upd,
  settings,
  setSettings,
}: {
  state: State
  upd: (f: (s: State) => void) => void
  settings: Settings
  setSettings: (s: Settings) => void
}) {
  const [token, setToken] = useState(settings.token)
  const [repo, setRepo] = useState(settings.repo)
  const [google, setGoogle] = useState(settings.google ?? '')
  const rows = [...state.incomes.map(r => ({ ...r, g: 'Месяц' })), ...state.assets.map(r => ({ ...r, g: 'Капитал' }))]
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
            const s = { ...settings, token, repo }
            saveSettings(s)
            setSettings(s)
          }}
        >
          Подключить
        </button>
        <p className="muted small">Ключ хранится только в этом браузере. Страница программы открыта всем, но без ключа в ней нет ваших данных.</p>
      </div>
      <div className="card">
        <h3>Куда ставить остаток из банка</h3>
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
      <div className="card">
        <h3>Google-таблица (кнопка «Получить Excel»)</h3>
        <label className="field">
          Идентификатор приложения Google (Client ID)
          <input value={google} onChange={e => setGoogle(e.target.value.trim())} placeholder="….apps.googleusercontent.com" autoComplete="off" />
        </label>
        <button
          className="primary"
          onClick={() => {
            const s = { ...settings, google }
            saveSettings(s)
            setSettings(s)
          }}
        >
          Сохранить
        </button>
        <p className="muted small">Нужен один раз на этом компьютере. Программа получает доступ только к таблицам, которые сама создаёт, — остальной Google Диск ей не виден.</p>
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

/** Когда банк последний раз отдал выписку и что пошло не так. */
function BankLine({ feed, refreshing, onRefresh, canRefresh }: { feed: BankFeed | null; refreshing: string; onRefresh: () => void; canRefresh: boolean }) {
  const button = canRefresh && (
    <button className="add" disabled={!!refreshing} onClick={onRefresh}>
      {refreshing ? <span className="spin">⟳</span> : '⟳'} {refreshing || 'Обновить из банка'}
    </button>
  )
  if (!feed)
    return (
      <div className="bankline small">
        <span className="muted">Выписка банка ещё не получена.</span> {button}
      </div>
    )
  const accs = (['pko', 'revolut'] as Bank[]).map(b => mainAccount(feed, b)).filter(Boolean)
  return (
    <div className="bankline small">
      {button}
      <span className="muted">Выписка банка от {ruDate(feed.fetchedAt)}:</span>{' '}
      {accs.map(a => (
        <span key={a!.uid} className="nowrap">
          {BANK_NAME[a!.bank]} <b>{fmt(a!.available)} zł</b>
          {Date.parse(feed.fetchedAt) - Date.parse(a!.at) > 36e5 && <span className="muted"> (данные от {ruDate(a!.at)})</span>}
          {'  '}
        </span>
      ))}
      {feed.errors.length > 0 && <div className="warn">Банк не ответил: {feed.errors.map(e => e.split(':')[0]).join(', ')} — показаны прежние данные.</div>}
    </div>
  )
}

/** Счёт дочки: остаток и движения по выписке банка. Только просмотр, в бюджет не входит. */
function DaughterTab({ feed }: { feed: BankFeed | null }) {
  const acc = feed?.accounts.find(a => a.role === 'daughter')
  if (!acc)
    return (
      <div className="card">
        <h3>Счёт дочки</h3>
        <p className="muted">Выписка ещё не получена — GitHub собирает её три раза в день.</p>
      </div>
    )
  const tx = [...acc.tx].sort((a, b) => b.date.localeCompare(a.date))
  const inSum = tx.filter(t => t.dir > 0).reduce((a, t) => a + t.amount, 0)
  const outSum = tx.filter(t => t.dir < 0).reduce((a, t) => a + t.amount, 0)
  return (
    <div className="grid">
      <div className="card">
        <div className="row-between">
          <h3>
            <span className="nmcell">
              <Logos name="PKO" />
              Счёт дочки · PKO …{acc.last4}
            </span>
          </h3>
          <span className="muted small">обновлено {ruDate(acc.at)}</span>
        </div>
        <div className="kpi inner">
          <div className="tile">
            <p>На счёте</p>
            <b>{fmt(acc.available)} zł</b>
          </div>
          <div className="tile">
            <p>Пришло за 35 дней</p>
            <b className="pos">+{fmt(inSum)} zł</b>
          </div>
          <div className="tile">
            <p>Потрачено за 35 дней</p>
            <b className="neg">−{fmt(outSum)} zł</b>
          </div>
        </div>
        {tx.length === 0 && <p className="muted">Движений за последние 35 дней нет.</p>}
        <table className="rows ops">
          <tbody>
            {tx.map(t => (
              <tr key={t.id}>
                <td className="muted nowrap">{ruDay(t.date).slice(0, 5)}</td>
                <td className="dtext">
                  {t.pending && <span className="tag">в обработке</span>} {txLabel(t.text)}
                </td>
                <td className={'r nowrap ' + (t.dir > 0 ? 'pos' : '')}>
                  {t.dir > 0 ? '+' : '−'}
                  {fmt(t.amount)} {t.cur === 'PLN' ? 'zł' : t.cur}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Дата следующего списания подписки: «7.11»; не списано в срок — красным. */
function DueLabel({ x, state, today }: { x: State['subs'][number]; state: State; today: Date }) {
  const d = nextDue(x, state, today)
  return d.overdue ? <span className="overdue">{dm(d.date)} — не списано</span> : <span className="muted">{dm(d.date)}</span>
}

/** Подписки на телефоне: полное название, под ним дата следующего списания и цена; нажатие — правка. */
function SubsList({ state, upd, rates, today }: { state: State; upd: (f: (s: State) => void) => void; rates: Rates; today: Date }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="mob sublist">
      {subOrder(state, today).map(i => {
        const x = state.subs[i]
        const pln = subPln(x, rates)
        return (
          <div key={x.id} className={'subrow' + (x.paid ? ' paid' : '')}>
            <div className="subhead" onClick={() => setOpen(open === x.id ? null : x.id)}>
              <Logos name={x.name} />
              <div className="subtxt">
                <div className="subname">{x.name || 'Без названия'}</div>
                <div className="submeta">
                  <DueLabel x={x} state={state} today={today} /> · {fmt(x.price)} {CUR_SIGN[x.cur ?? 'PLN']}
                  {x.cur && x.cur !== 'PLN' && <> ≈ {fmt(pln)} zł</>}
                  {x.partial && !x.paid && (x.paidAmt ?? 0) > 0 && <> · оплачено {fmt(x.paidAmt ?? 0)}</>}
                </div>
              </div>
              <input
                type="checkbox"
                className="chk"
                checked={x.paid}
                onClick={e => e.stopPropagation()}
                onChange={e =>
                  upd(s => {
                    s.subs[i].paid = e.target.checked
                    if (!e.target.checked) s.subs[i].paidAmt = 0
                  })
                }
              />
            </div>
            {open === x.id && (
              <div className="subedit">
                <label>
                  <span>Название</span>
                  <Txt value={x.name} placeholder="Сервис" onChange={v => upd(s => void (s.subs[i].name = v))} />
                </label>
                <label>
                  <span>День списания</span>
                  <Num width={56} money={false} value={x.day} onChange={v => upd(s => void (s.subs[i].day = v))} />
                </label>
                <label>
                  <span>Цена</span>
                  <MoneyInput
                    m={{ v: x.price, cur: x.cur ?? 'PLN' }}
                    rates={rates}
                    live
                    onChange={mo => upd(s => void Object.assign(s.subs[i], { price: mo.v, cur: mo.cur === 'PLN' ? undefined : mo.cur }))}
                  />
                </label>
                <button className="add danger" onClick={() => confirm(`Удалить «${x.name}»?`) && upd(s => void s.subs.splice(i, 1))}>
                  Удалить подписку
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const RENT_PARTS = [
  ['chynsh', 'чынш'],
  ['electr', 'свет'],
  ['rent', 'наём'],
] as const

/** Оплата квартиры на телефоне: дата и сумма, ниже — только непустые части; нажатие — правка. */
function RentCard({ p, i, upd }: { p: State['rent'][number]; i: number; upd: (f: (s: State) => void) => void }) {
  const [open, setOpen] = useState(false)
  const total = p.chynsh + p.electr + p.rent
  return (
    <div className="rentcard">
      <div className="renthead" onClick={() => setOpen(!open)}>
        <b>{p.date ? parseDate(p.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\s*г\.$/, '') : 'без даты'}</b>
        {p.auto && <span className="tag">авто</span>}
        <b className="renttotal">{fmt(total)}</b>
      </div>
      <div className="chips" onClick={() => setOpen(!open)}>
        {RENT_PARTS.filter(([k]) => p[k]).map(([k, label]) => (
          <span key={k} className="chip">
            {label} {fmt(p[k], 0)}
          </span>
        ))}
        {p.note && <span className="chip">{p.note}</span>}
      </div>
      {open && (
        <div className="subedit">
          <label>
            <span>Дата</span>
            <input type="date" value={p.date} onChange={e => upd(s => void (s.rent[i].date = e.target.value))} />
          </label>
          {RENT_PARTS.map(([k, label]) => (
            <label key={k}>
              <span>{label[0].toUpperCase() + label.slice(1)}</span>
              <Num width={90} value={p[k]} onChange={v => upd(s => void (s.rent[i][k] = v))} />
            </label>
          ))}
          <label>
            <span>Заметка</span>
            <Txt value={p.note} onChange={v => upd(s => void (s.rent[i].note = v))} />
          </label>
          <button className="add danger" onClick={() => confirm('Удалить запись?') && upd(s => void s.rent.splice(i, 1))}>
            Удалить запись
          </button>
        </div>
      )}
    </div>
  )
}

/** Убрать из списка уведомление, которое ни на что не повлияло (вход в приложение, реклама и т. п.). Повторно оно не появится. */
function DropOp({ id, upd }: { id: number; upd: (f: (s: State) => void) => void }) {
  return (
    <button className="x" aria-label="Удалить" title="Удалить из списка" onClick={() => upd(s => void (s.ops = s.ops.filter(o => o.id !== id)))}>
      ×
    </button>
  )
}

/**
 * «Получить Excel» (только на компьютере): новая Google-таблица в раскладке старого листа с текущими данными.
 * Каждый раз — отдельный файл; старая таблица пользователя не открывается и не меняется.
 */
function SheetButton({ state, rates, today, settings, openSettings }: { state: State; rates: Rates; today: Date; settings: Settings; openSettings: () => void }) {
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const go = async () => {
    if (!settings.google) return openSettings()
    setBusy(true)
    setErr('')
    setUrl('')
    try {
      const token = await googleToken(settings.google)
      const stamp = today.toLocaleDateString('ru-RU')
      const link = await createSpreadsheet(token, sheetBody(buildGrid(state, rates, today), `Бюджет ${stamp}`, String(today.getFullYear())))
      setUrl(link)
      window.open(link, '_blank')
    } catch (e: any) {
      setErr(e.message || 'Не получилось')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="desk sheetbtn">
      <button className="add" disabled={busy} onClick={go} title="Новая Google-таблица в раскладке старого листа, с текущими данными">
        {busy ? <span className="spin">⟳</span> : '▦'} {busy ? 'Создаю таблицу…' : 'Получить Excel'}
      </button>
      {url && (
        <span className="small">
          {' '}
          <a href={url} target="_blank" rel="noreferrer">
            открыть таблицу
          </a>{' '}
          <button className="link" onClick={() => navigator.clipboard?.writeText(url)}>
            скопировать ссылку
          </button>
        </span>
      )}
      {err && <span className="warn small"> {err}</span>}
    </div>
  )
}
