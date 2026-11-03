import { useEffect, useRef, useState } from 'react'
import { toPln } from './calc'
import { uid } from './state'
import { CURRENCIES, CUR_SIGN, type Money, type Rates, type Row } from './types'

export const fmt = (n: number, d = 0) =>
  (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })

const parseNum = (s: string) => {
  const n = Number(s.replace(/[\s ]/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/** Числовое поле: пока печатаешь, текст свой; запятая и пробелы допустимы. */
export function Num({ value, onChange, className, width }: { value: number; onChange: (n: number) => void; className?: string; width?: number }) {
  const [text, setText] = useState(value ? String(value).replace('.', ',') : '')
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value ? String(value).replace('.', ',') : '')
  }, [value])
  return (
    <input
      className={className ?? 'num'}
      style={width ? { width } : undefined}
      inputMode="decimal"
      value={text}
      placeholder="0"
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        setText(value ? String(value).replace('.', ',') : '')
      }}
      onChange={e => {
        setText(e.target.value)
        onChange(parseNum(e.target.value))
      }}
    />
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
                <input className="name" value={r.name} placeholder="Название" onChange={e => set(i, { name: e.target.value })} />
                {extra?.(r)}
              </td>
              {withPlan && (
                <td className="r">
                  <Num className="num plan" width={64} value={r.plan ?? 0} onChange={plan => set(i, { plan })} />
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
