import { brandsOf } from './brands'
import type { Op, State } from './types'

/**
 * Автоматическое разнесение операции по вкладкам: доход — в «Налоги», платёж в налоговую — во «Взносы»,
 * чынш и электричество — в факт расходов месяца (и чынш — в историю квартиры).
 * Узнаём по названию отправителя/получателя, как оно пишется в банке.
 */
type Rule =
  | { kind: 'income'; re: RegExp; column: (name: string) => boolean; keepBalance?: boolean }
  | { kind: 'skip'; re: RegExp }
  | { kind: 'taxpay'; re: RegExp }
  | { kind: 'expense'; re: RegExp; row: RegExp; rent?: 'chynsh' | 'electr' }

const isBrand = (key: string) => (name: string) => brandsOf(name).some(b => b.key === key)

/** Общие правила. Личные (работодатели, свои получатели) хранятся в закрытых данных — State.rules. */
const BUILTIN: Rule[] = [
  { kind: 'income', re: /patreon|payoneer/i, column: isBrand('patreon') },
  { kind: 'income', re: /citibank europe|stripe|buy\s*me\s*a\s*coffee/i, column: isBrand('bmc') },
  { kind: 'taxpay', re: /urz[ąa]d skarbow|org\.?\s*podatkow|mikrorachun/i },
  { kind: 'expense', re: /wsp[óo]lnota mieszkaniowa/i, row: /чынш|czynsz|wsp[óo]lnot/i, rent: 'chynsh' },
]

const safeRe = (src: string) => {
  try {
    return new RegExp(src, 'i')
  } catch {
    return /$^/
  }
}

/** Личные правила из закрытых данных идут первыми: они точнее общих. */
function rulesOf(s: State): Rule[] {
  const own: Rule[] = (s.rules ?? []).map(r =>
    r.kind === 'income'
      ? { kind: 'income', re: safeRe(r.match), column: (n: string) => safeRe(r.column ?? '$^').test(n), keepBalance: r.keepBalance }
      : r.kind === 'expense'
        ? { kind: 'expense', re: safeRe(r.match), row: safeRe(r.row ?? '$^'), rent: r.rent }
        : { kind: r.kind, re: safeRe(r.match) },
  )
  return [...own, ...BUILTIN]
}

export function ruleOf(s: State, op: Op): Rule | undefined {
  const text = op.manual ? op.note || '' : op.text
  const r = rulesOf(s).find(r => r.re.test(text) && (r.kind === 'income' || r.kind === 'skip' ? op.dir > 0 : op.dir < 0))
  return r?.kind === 'skip' ? undefined : r
}

/** Доход в валюте, который не должен менять остаток злотой карты (зарплата в евро). */
export function keepsBalance(s: State, op: Op): boolean {
  const r = ruleOf(s, op)
  return !!r && r.kind === 'income' && !!r.keepBalance && op.cur !== 'PLN'
}

/** Дата операции по местному времени, YYYY-MM-DD. */
const localDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const round2 = (n: number) => Math.round(n * 100) / 100
const uid = () => Math.random().toString(36).slice(2, 10)

/** Разнести применённую операцию. Повторно уже записанное (та же дата и сумма) не добавляется. */
export function book(s: State, op: Op) {
  if (op.booked || op.amount === null) return
  const r = ruleOf(s, op)
  if (!r) return
  const date = localDate(op.at)
  const amount = op.amount
  if (r.kind === 'income') {
    const col = s.tax.columns.find(c => r.column(c.name))
    if (!col) return
    const cur = op.cur === 'PLN' ? undefined : op.cur
    const dup = col.items.find(x => x.date === date && Math.abs(x.v - amount) < 0.005 && (x.cur ?? 'PLN') === op.cur)
    if (dup) {
      op.booked = { kind: 'income', colId: col.id, itemId: dup.id, existed: true }
      return
    }
    const id = uid()
    col.items.push({ id, v: amount, date, ...(cur ? { cur } : {}), auto: op.id })
    op.booked = { kind: 'income', colId: col.id, itemId: id }
  } else if (r.kind === 'taxpay') {
    const dup = s.tax.payments.find(x => x.date === date && Math.abs(x.amount - amount) < 0.005)
    if (dup) {
      op.booked = { kind: 'taxpay', itemId: dup.id, existed: true }
      return
    }
    const id = uid()
    s.tax.payments.push({ id, date, amount, auto: op.id })
    op.booked = { kind: 'taxpay', itemId: id }
  } else if (r.kind === 'expense') {
    const row = s.expenses.find(x => r.row.test(x.name))
    if (row) row.amt = { ...row.amt, v: round2(row.amt.v + amount) }
    let rentId: string | undefined
    if (r.rent) {
      rentId = uid()
      s.rent.unshift({ id: rentId, date, chynsh: 0, electr: 0, rent: 0, note: 'авто', [r.rent]: amount, auto: op.id })
    }
    op.booked = { kind: 'expense', rowId: row?.id, itemId: rentId, amount }
  }
}

/** Отменить разнесение (операцию отменили или удалили). Записи, которые были до неё, не трогаем. */
export function unbook(s: State, op: Op) {
  const b = op.booked
  if (!b) return
  op.booked = undefined
  if (b.existed) return
  if (b.kind === 'income') {
    const col = s.tax.columns.find(c => c.id === b.colId)
    if (col) col.items = col.items.filter(x => x.id !== b.itemId)
  } else if (b.kind === 'taxpay') {
    s.tax.payments = s.tax.payments.filter(x => x.id !== b.itemId)
  } else {
    const row = s.expenses.find(x => x.id === b.rowId)
    if (row && b.amount) row.amt = { ...row.amt, v: round2(Math.max(0, row.amt.v - b.amount)) }
    if (b.itemId) s.rent = s.rent.filter(x => x.id !== b.itemId)
  }
}

/** Куда разнесено — для подписи в «Операциях». */
export function bookedLabel(s: State, op: Op): string | null {
  const b = op.booked
  if (!b) return null
  if (b.kind === 'income') {
    const col = s.tax.columns.find(c => c.id === b.colId)
    return `${b.existed ? 'Уже было в налогах' : '→ Налоги'}: ${col?.name ?? ''}`
  }
  if (b.kind === 'taxpay') return b.existed ? 'Уже было во взносах в Urząd Skarbowy' : '→ Взнос в Urząd Skarbowy'
  const row = s.expenses.find(x => x.id === b.rowId)
  return `→ Расходы: ${row?.name ?? '—'}${b.itemId ? ' и история квартиры' : ''}`
}
