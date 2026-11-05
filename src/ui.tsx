import { useEffect, useRef, useState } from 'react'
import { brandsOf } from './brands'
import { toPln } from './calc'
import { uid } from './state'
import { CURRENCIES, CUR_SIGN, type Money, type Rates, type Row } from './types'

/** Денежные суммы — всегда с сотыми. */
export const fmt = (n: number, d = 2) =>
  (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })

const parseNum = (s: string) => {
  const n = Number(s.replace(/[\s ]/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/** Телефон/планшет: у цифровой клавиатуры iPhone нет «Ввода» — значение вносится, когда уходишь из поля. */
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/**
 * Поле, которое на компьютере вносит значение только по «Ввод» (ушли без «Ввода» — вписанное отменяется),
 * а на телефоне — и при уходе из поля. Пока не подтверждено, поле подсвечено (класс pending).
 */
function Draft({
  shown,
  commit,
  className,
  width,
  placeholder,
  inputMode,
}: {
  shown: string
  commit: (text: string) => void
  className: string
  width?: number
  placeholder?: string
  inputMode?: 'decimal'
}) {
  const [text, setText] = useState(shown)
  const editing = useRef(false)
  const committed = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(shown)
  }, [shown])
  const pending = text !== shown
  return (
    <span className="draft">
      <input
        className={className + (pending ? ' pending' : '')}
        style={width ? { width } : undefined}
        value={text}
        placeholder={placeholder}
        inputMode={touch ? inputMode : undefined}
        enterKeyHint="enter"
        title={pending ? 'Нажмите «Ввод», чтобы внести' : undefined}
        onFocus={() => (editing.current = true)}
        onBlur={() => {
          editing.current = false
          // После «Ввода» оставляем вписанное — значение уже внесено; на телефоне вносим и без «Ввода»; иначе отменяем.
          if (!committed.current) {
            if (touch && text !== shown) commit(text)
            else setText(shown)
          }
          committed.current = false
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(text)
            committed.current = true
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setText(shown)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        onChange={e => setText(e.target.value)}
      />
      {pending && <span className="enter">↵</span>}
    </span>
  )
}

const numText = (v: number, money: boolean) => (!v ? '' : money ? v.toFixed(2).replace('.', ',') : String(v).replace('.', ','))

/** Число: запятая и пробелы допустимы, вносится по «Ввод». Денежное (по умолчанию) — с сотыми; для дня, года, процента — money={false}. */
export function Num({
  value,
  onChange,
  className,
  width,
  money = true,
}: {
  value: number
  onChange: (n: number) => void
  className?: string
  width?: number
  money?: boolean
}) {
  const commit = (t: string) => onChange(money ? Math.round(parseNum(t) * 100) / 100 : parseNum(t))
  return <Draft shown={numText(value, money)} commit={commit} className={className ?? 'num'} width={width} placeholder={money ? '0,00' : '0'} inputMode="decimal" />
}

/** Текст (название строки), вносится по «Ввод». */
export function Txt({ value, onChange, className, placeholder }: { value: string; onChange: (s: string) => void; className?: string; placeholder?: string }) {
  return <Draft shown={value} commit={t => onChange(t.trim())} className={className ?? 'name'} placeholder={placeholder} />
}

/** Логотипы брендов, найденных в названии. */
export function Logos({ name }: { name: string }) {
  const list = brandsOf(name)
  if (!list.length) return null
  return (
    <span className="logos">
      {list.map(b => (
        <span key={b.key} className="lg">
          <img src={b.src} alt="" />
        </span>
      ))}
    </span>
  )
}

/**
 * Сумма с валютой. Двойной клик (или долгое нажатие на телефоне) — меню валют.
 * live: курс всегда текущий (для денег, которые лежат в валюте); иначе курс фиксируется в момент выбора.
 */
export function MoneyInput({ m, onChange, rates, live }: { m: Money; onChange: (m: Money) => void; rates: Rates; live?: boolean }) {
  const [menu, setMenu] = useState(false)
  const timer = useRef<number>()
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  return (
    <div className="money" ref={wrap}>
      <div
        className="money-in"
        onDoubleClick={() => setMenu(true)}
        onTouchStart={() => (timer.current = window.setTimeout(() => setMenu(true), 550))}
        onTouchEnd={() => clearTimeout(timer.current)}
        onTouchMove={() => clearTimeout(timer.current)}
      >
        <Num value={m.v} onChange={v => onChange({ ...m, v })} />
        {m.cur !== 'PLN' && <span className="cur">{CUR_SIGN[m.cur]}</span>}
      </div>
      {m.cur !== 'PLN' && <div className="conv">≈ {fmt(toPln(m, rates))} zł</div>}
      {menu && (
        <div className="menu">
          {CURRENCIES.map(c => (
            <button
              key={c}
              className={c === m.cur ? 'on' : ''}
              onClick={() => {
                onChange({ v: m.v, cur: c, ...(c === 'PLN' || live ? {} : { rate: rates[c] }) })
                setMenu(false)
              }}
            >
              {CUR_SIGN[c]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Rows({
  rows,
  onChange,
  rates,
  live,
  withPlan,
  addLabel = '+ строка',
  extra,
}: {
  rows: Row[]
  onChange: (rows: Row[]) => void
  rates: Rates
  live?: boolean
  withPlan?: boolean
  addLabel?: string
  extra?: (r: Row) => React.ReactNode
}) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <>
      <table className="rows">
        {withPlan && rows.length > 0 && (
          <thead>
            <tr>
              <th />
              <th className="r">план</th>
              <th className="r">факт</th>
              <th />
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td>
                <div className="nmcell">
                  <Logos name={r.name} />
                  <Txt value={r.name} placeholder="Название" onChange={name => set(i, { name })} />
                  {extra?.(r)}
                </div>
              </td>
              {withPlan && (
                <td className="r">
                  <Num className="num plan" width={86} value={r.plan ?? 0} onChange={plan => set(i, { plan })} />
                </td>
              )}
              <td className="r">
                <MoneyInput m={r.amt} rates={rates} live={live} onChange={amt => set(i, { amt })} />
              </td>
              <td className="del">
                <button
                  className="x"
                  aria-label="Удалить строку"
                  onClick={() => confirm(`Удалить «${r.name || 'строку'}»?`) && onChange(rows.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="add" onClick={() => onChange([...rows, { id: uid(), name: '', amt: { v: 0, cur: 'PLN' }, ...(withPlan ? { plan: 0 } : {}) }])}>
        {addLabel}
      </button>
    </>
  )
}
