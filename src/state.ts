import { toPln } from './calc'
import { parseNotification, splitComment } from './parse'
import type { Op, Rates, State } from './types'

export const uid = () => Math.random().toString(36).slice(2, 10)

export function emptyState(): State {
  return {
    version: 1,
    payday: '',
    incomes: [],
    expenses: [],
    toCapital: 0,
    fromCapital: 0,
    subs: [],
    assets: [],
    liabilities: [],
    prepaid: { paidOn: '', until: '', amount: 0 },
    tax: {
      year: new Date().getFullYear(),
      columns: [
        { id: uid(), name: 'Patreon', rate: 12, items: [] },
        { id: uid(), name: 'Зарплата', rate: 6.1, items: [] },
        { id: uid(), name: 'Кофе', rate: 12, items: [] },
      ],
      payments: [],
    },
    rent: [],
    bankLinks: { pko: null, revolut: null },
    ops: [],
    lastCommentId: 0,
  }
}

const linkedRow = (s: State, op: Op) => [...s.incomes, ...s.assets].find(r => r.id === s.bankLinks[op.bank])

/** Ищет строку, привязанную к банку, и меняет её сумму на delta злотых (в валюте строки). */
function moveLinked(s: State, op: Op, deltaPln: number, rates: Rates) {
  const row = linkedRow(s, op)
  if (!row) return false
  const perUnit = row.amt.cur === 'PLN' ? 1 : toPln({ ...row.amt, v: 1 }, rates)
  row.amt = { ...row.amt, v: Math.round((row.amt.v + deltaPln / perUnit) * 100) / 100 }
  return true
}

export interface Comment {
  id: number
  created_at: string
  body: string
}

/** Превращает новые комментарии из Команды в операции и меняет суммы на счетах. Возвращает новое состояние. */
export function ingest(prev: State, comments: Comment[], rates: Rates): State {
  const s: State = structuredClone(prev)
  for (const c of comments.sort((a, b) => a.id - b.id)) {
    if (c.id <= s.lastCommentId) continue
    s.lastCommentId = c.id
    const { bank, text } = splitComment(c.body)
    if (!bank || !text) continue
    const p = parseNotification(text)
    const op: Op = { id: c.id, at: c.created_at, bank, text, amount: p.amount, cur: p.cur, dir: p.dir, status: 'unknown' }
    if (p.balance !== undefined) op.balance = p.balance
    if (p.amount !== null && p.dir !== 0) applyOp(s, op, p.dir, rates)
    s.ops.unshift(op)
  }
  s.ops = s.ops.slice(0, 500)
  return s
}

/** Применить (или вручную подтвердить) операцию с направлением dir. Меняет s на месте. */
export function applyOp(s: State, op: Op, dir: 1 | -1, rates: Rates) {
  if (op.amount === null) return
  const row = linkedRow(s, op)
  if (op.balance !== undefined && row?.amt.cur === 'PLN') {
    op.pln = Math.round((op.balance - row.amt.v) * 100) / 100
    row.amt = { ...row.amt, v: op.balance }
    op.dir = dir
    op.status = 'applied'
    return
  }
  const pln = dir * toPln({ v: op.amount, cur: op.cur }, rates)
  if (moveLinked(s, op, pln, rates)) {
    op.dir = dir
    op.status = 'applied'
    op.pln = pln
  }
}

/** Отменить применённую операцию (например, ошиблись с направлением). */
export function undoOp(s: State, op: Op, rates: Rates) {
  if (op.status !== 'applied' || op.pln === undefined) return
  moveLinked(s, op, -op.pln, rates)
  op.status = 'unknown'
  op.pln = undefined
}
