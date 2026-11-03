import { RENAMES } from './brands'
import { toPln } from './calc'
import { parseNotification, splitComment } from './parse'
import type { Op, Rates, State } from './types'

export const uid = () => Math.random().toString(36).slice(2, 10)

export function emptyState(): State {
  return {
    version: 2,
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
        { id: uid(), name: 'Buy Me a Coffee', rate: 12, items: [] },
      ],
      payments: [],
    },
    rent: [],
    bankLinks: { pko: null, revolut: null },
    ops: [],
    lastCommentId: 0,
    poker: [],
  }
}

/** Обновляет данные старых версий. Возвращает тот же объект, если менять нечего. */
export function migrate(s: any): State {
  if (s?.version === 2) return s
  const n = structuredClone(s)
  const ren = (r: { name: string }) => (r.name = RENAMES[r.name] ?? r.name)
  ;[n.incomes, n.expenses, n.subs, n.assets, n.liabilities, n.tax?.columns].forEach((l: any[] | undefined) => l?.forEach(ren))
  n.poker ??= []
  n.version = 2
  return n
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
    const twin = p.amount !== null ? findManualTwin(s, op) : undefined
    if (twin) {
      // Эти деньги уже внесены вручную — второй раз не считаем.
      op.status = 'matched'
      op.dir = twin.dir
      op.matchedWith = twin.id
      twin.matchedWith = op.id
    } else if (p.amount !== null && p.dir !== 0) applyOp(s, op, p.dir, rates)
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

const DAY_MS = 864e5
const sameAmount = (a: Op, b: Op) => a.amount !== null && b.amount !== null && a.cur === b.cur && Math.abs(a.amount - b.amount) < 0.005

/**
 * Ручная запись, которой соответствует пришедшее уведомление: тот же банк, та же сумма,
 * то же направление (если банк его указал), внесена не раньше чем за 10 дней и не позже чем через день.
 */
export function findManualTwin(s: State, op: Op): Op | undefined {
  const t = Date.parse(op.at)
  return s.ops
    .filter(m => m.manual && m.status === 'applied' && !m.matchedWith && m.bank === op.bank && sameAmount(m, op))
    .filter(m => (op.dir === 0 || m.dir === op.dir) && t - Date.parse(m.at) <= 10 * DAY_MS && Date.parse(m.at) - t <= DAY_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
}

/** Уже пришедшее от банка уведомление с такой же суммой за последние 10 дней — чтобы предупредить перед ручной записью. */
export function findAutoTwin(s: State, op: Op): Op | undefined {
  const t = Date.parse(op.at)
  return s.ops.find(
    a => !a.manual && a.status !== 'ignored' && !a.matchedWith && a.bank === op.bank && sameAmount(a, op) && (a.dir === 0 || a.dir === op.dir) && t - Date.parse(a.at) <= 10 * DAY_MS,
  )
}

/** Ручная операция: сразу меняет сумму на привязанном счёте и остаётся в истории. */
export function addManual(s: State, bank: Op['bank'], dir: 1 | -1, amount: number, note: string, rates: Rates, at = new Date().toISOString()): Op {
  const op: Op = { id: -Date.now(), at, bank, text: note, note, amount, cur: 'PLN', dir, status: 'unknown', manual: true }
  while (s.ops.some(o => o.id === op.id)) op.id--
  const pln = dir * amount
  if (moveLinked(s, op, pln, rates)) {
    op.status = 'applied'
    op.pln = pln
  }
  s.ops.unshift(op)
  return op
}

/** Удалить ручную запись: деньги возвращаются на счёт, а совпавшее уведомление снова ждёт решения. */
export function removeManual(s: State, id: number, rates: Rates) {
  const i = s.ops.findIndex(o => o.id === id && o.manual)
  if (i < 0) return
  const m = s.ops[i]
  if (m.status === 'applied' && m.pln !== undefined) moveLinked(s, m, -m.pln, rates)
  const twin = s.ops.find(o => o.id === m.matchedWith)
  if (twin) {
    twin.status = 'unknown'
    twin.matchedWith = undefined
  }
  s.ops.splice(i, 1)
}

/** Уведомление совпало с ручной записью, но это другие деньги — учесть отдельно. */
export function unmatch(s: State, id: number, rates: Rates) {
  const op = s.ops.find(o => o.id === id)
  if (!op || op.status !== 'matched') return
  const m = s.ops.find(o => o.id === op.matchedWith)
  if (m) m.matchedWith = undefined
  op.matchedWith = undefined
  op.status = 'unknown'
  // По сумме, а не по остатку: остаток из запоздавшего уведомления мог устареть.
  if (op.dir && op.amount !== null) {
    const pln = op.dir * toPln({ v: op.amount, cur: op.cur }, rates)
    if (moveLinked(s, op, pln, rates)) {
      op.status = 'applied'
      op.pln = pln
    }
  }
}
