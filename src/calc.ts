import type { Money, Rates, Row, State, Sub, TaxItem } from './types'

export const DAY = 864e5

export function toPln(m: Money, rates: Rates): number {
  if (m.cur === 'PLN') return m.v
  return m.v * (m.rate ?? rates[m.cur] ?? 0)
}

export const sumRows = (rows: Row[], rates: Rates) => rows.reduce((a, r) => a + toPln(r.amt, rates), 0)

/** Полночь по местному времени для даты вида 2026-11-13. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function daysLeft(payday: string, today: Date): number {
  if (!payday) return 0
  return Math.round((parseDate(payday).getTime() - startOfDay(today).getTime()) / DAY)
}

export const subPln = (x: Sub, rates: Rates) => toPln({ v: x.price, cur: x.cur ?? 'PLN' }, rates)
/** Сколько по подписке ещё не списано: цена минус уже оплаченные части. */
export const subRemaining = (x: Sub, rates: Rates) => (x.paid ? 0 : Math.max(0, subPln(x, rates) - (x.paidAmt ?? 0)))
export const subsLeft = (s: State, rates: Rates) => s.subs.reduce((a, x) => a + subRemaining(x, rates), 0)

export function month(s: State, rates: Rates, today: Date) {
  const income = sumRows(s.incomes, rates) + s.fromCapital
  const subs = subsLeft(s, rates)
  const expense = sumRows(s.expenses, rates) + subs + s.toCapital
  const rest = income - expense
  const days = daysLeft(s.payday, today)
  return { income, expense, subs, rest, days, perDay: days > 0 ? rest / days : null }
}

function monthsBetween(a: Date, b: Date): number {
  let n = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()
  if (b.getDate() < a.getDate()) n--
  return n
}

/**
 * Неизрасходованная часть оплаты квартиры наперёд: сумма делится поровну на оплаченные месяцы,
 * с каждым прошедшим месяцем от даты оплаты прибавка уменьшается на одну долю.
 */
export function prepaidLeft(p: State['prepaid'], today: Date): number {
  if (!p.paidOn || !p.until || !p.amount) return 0
  const from = parseDate(p.paidOn)
  const to = parseDate(p.until)
  const t = startOfDay(today)
  if (t >= to || t < from) return t < from ? p.amount : 0
  const total = Math.max(1, monthsBetween(from, to))
  const passed = Math.max(0, monthsBetween(from, t))
  return Math.max(0, (p.amount * (total - passed)) / total)
}

/** Доход в злотых для налога: злотые как пришли, валюта — по курсу NBP за день до поступления. */
export const itemPln = (x: TaxItem) => (!x.cur || x.cur === 'PLN' ? x.v : Math.round(x.v * (x.rate ?? 0) * 100) / 100)

export function tax(s: State) {
  const cols = s.tax.columns.map(c => {
    const income = c.items.reduce((a, x) => a + itemPln(x), 0)
    return { id: c.id, income, due: (income * c.rate) / 100 }
  })
  const due = cols.reduce((a, c) => a + c.due, 0)
  const paid = s.tax.payments.reduce((a, x) => a + x.amount, 0)
  return { cols, due, paid, left: due - paid }
}

export function capital(s: State, rates: Rates, today: Date) {
  const assets = sumRows(s.assets, rates) + s.toCapital
  const taxLeft = Math.max(0, tax(s).left)
  const debts = sumRows(s.liabilities, rates) + taxLeft + s.fromCapital
  const onHand = assets - debts
  const prepaid = prepaidLeft(s.prepaid, today)
  return { assets, debts, taxLeft, onHand, prepaid, total: onHand + prepaid }
}

const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate()
const onDay = (y: number, m: number, day: number) => new Date(y, m, Math.min(Math.max(1, day), daysIn(y, m)))

/** Начало текущего месяца бюджета: прошлая дата поступления (или за месяц до следующей). */
export function cycleStart(s: State, today: Date): Date {
  if (s.lastCycle?.payday) return parseDate(s.lastCycle.payday)
  if (s.payday) {
    const p = parseDate(s.payday)
    return onDay(p.getFullYear(), p.getMonth() - 1, p.getDate())
  }
  return new Date(today.getFullYear(), today.getMonth(), 1)
}

/**
 * Следующее списание подписки: первый её день начиная с начала месяца бюджета;
 * уже оплачена — тот же день месяцем позже. Не оплачена, а день прошёл — просрочка.
 */
export function nextDue(x: Sub, s: State, today: Date): { date: Date; overdue: boolean } {
  const st = cycleStart(s, today)
  let d = onDay(st.getFullYear(), st.getMonth(), x.day)
  if (d < st) d = onDay(st.getFullYear(), st.getMonth() + 1, x.day)
  if (x.paid) d = onDay(d.getFullYear(), d.getMonth() + 1, x.day)
  return { date: d, overdue: !x.paid && d < startOfDay(today) }
}

/** Порядок подписок в списке: сначала неоплаченные по ближайшему сроку (просроченные — первыми), оплаченные — в самом низу. */
export function subOrder(s: State, today: Date): number[] {
  const due = s.subs.map(x => nextDue(x, s, today).date.getTime())
  return s.subs.map((_, i) => i).sort((a, b) => Number(s.subs[a].paid) - Number(s.subs[b].paid) || due[a] - due[b])
}

export const dm = (d: Date) => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`
