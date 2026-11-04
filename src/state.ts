import { book, keepsBalance, unbook } from './autobook'
import { merchantHit, RENAMES } from './brands'
import { subRemaining, toPln } from './calc'
import { parseNotification, splitComment } from './parse'
import type { Op, Rates, State, Sub } from './types'

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
        { id: uid(), name: 'Зарплата', rate: 6, items: [] },
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
  op.dir = dir
  if (keepsBalance(s, op)) {
    // Зарплата в евро: на злотой карте её ещё нет — только в налоги.
    op.status = 'applied'
    op.pln = 0
    book(s, op)
    return
  }
  const row = linkedRow(s, op)
  if (op.balance !== undefined && row?.amt.cur === 'PLN') {
    op.pln = Math.round((op.balance - row.amt.v) * 100) / 100
    row.amt = { ...row.amt, v: op.balance }
    op.dir = dir
    op.status = 'applied'
    markSub(s, op, rates)
    book(s, op)
    return
  }
  const pln = dir * toPln({ v: op.amount, cur: op.cur }, rates)
  if (moveLinked(s, op, pln, rates)) {
    op.dir = dir
    op.status = 'applied'
    op.pln = pln
    markSub(s, op, rates)
    book(s, op)
  }
}

/** Отменить применённую операцию (например, ошиблись с направлением). */
export function undoOp(s: State, op: Op, rates: Rates) {
  if (op.status !== 'applied' || op.pln === undefined) return
  moveLinked(s, op, -op.pln, rates)
  op.status = 'unknown'
  op.pln = undefined
  unmarkSub(s, op)
  unbook(s, op)
}

const DAY_MS = 864e5
const sameAmount = (a: Op, b: Op) => a.amount !== null && b.amount !== null && a.cur === b.cur && Math.abs(a.amount - b.amount) < 0.005

/**
 * Ручная запись (или операция, уже взятая из выписки банка), которой соответствует пришедшее уведомление: тот же банк, та же сумма,
 * то же направление (если банк его указал), внесена не раньше чем за 10 дней и не позже чем через день.
 */
export function findManualTwin(s: State, op: Op): Op | undefined {
  const t = Date.parse(op.at)
  return s.ops
    .filter(m => (m.manual || m.fromBank) && m.status === 'applied' && !m.matchedWith && m.bank === op.bank && sameAmount(m, op))
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
  if (dir < 0) markSub(s, op, rates)
  if (op.status === 'applied') book(s, op)
  s.ops.unshift(op)
  return op
}

/** Удалить ручную запись: деньги возвращаются на счёт, а совпавшее уведомление снова ждёт решения. */
export function removeManual(s: State, id: number, rates: Rates) {
  const i = s.ops.findIndex(o => o.id === id && o.manual)
  if (i < 0) return
  const m = s.ops[i]
  if (m.status === 'applied' && m.pln !== undefined) moveLinked(s, m, -m.pln, rates)
  unmarkSub(s, m)
  unbook(s, m)
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
      book(s, op)
    }
  }
}

/**
 * Списание на подписку ставит галочку «оплачено» у подписки, которую узнали в тексте.
 * 1) сумма близка к остатку подписки — берём самую близкую;
 * 2) подписка, которую платят частями (телефоны), и списание меньше остатка — засчитываем часть, галочка — когда оплачено всё;
 * 3) однозначное название (Hetzner, OpenAI…) — засчитываем даже при другой сумме.
 * Общие названия (APPLE.COM/BILL, «opłata», магазин цветов) — только по пункту 1.
 */
export function markSub(s: State, op: Op, rates: Rates) {
  if (op.dir !== -1 || op.amount === null || op.subId) return
  const text = op.manual ? op.note || '' : op.text
  if (!text) return
  const pln = toPln({ v: op.amount, cur: op.cur }, rates)
  const near = (r: number) => r > 0 && Math.abs(pln - r) <= Math.max(2, r * 0.25)
  const cands = s.subs.filter(x => !x.paid).map(x => ({ x, hit: merchantHit(x.name, text), rest: subRemaining(x, rates) }))
  const hits = cands.filter(c => c.hit > 0)
  const close = hits.filter(c => near(c.rest)).sort((a, b) => Math.abs(pln - a.rest) - Math.abs(pln - b.rest))[0]
  const part = hits.find(c => c.x.partial && pln < c.rest - 0.01)
  const strong = hits.find(c => c.hit === 2 && !c.x.partial)
  if (close) {
    close.x.paid = true
    op.subId = close.x.id
    shiftDay(close.x, op)
  } else if (part) {
    part.x.paidAmt = Math.round(((part.x.paidAmt ?? 0) + pln) * 100) / 100
    op.subId = part.x.id
    op.subPart = pln
  } else if (strong) {
    strong.x.paid = true
    op.subId = strong.x.id
    shiftDay(strong.x, op)
  }
}

/**
 * Сервис списал на день-другой раньше или позже — подписка переезжает на фактический день.
 * Не сдвигаем по выписке PKO (там дата проведения, а не покупки), по ручным записям и если разница больше 5 дней.
 */
function shiftDay(x: Sub, op: Op) {
  if (op.manual || (op.fromBank && op.bank === 'pko')) return
  const d = new Date(op.at)
  const day = d.getDate()
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  if (day === x.day || (x.day > last && day === last)) return
  const diff = Math.min(Math.abs(day - x.day), 31 - Math.abs(day - x.day))
  if (diff > 5) return
  op.subDayWas = x.day
  x.day = day
}

/** Операцию отменили — снять галочку, которую она поставила. */
function unmarkSub(s: State, op: Op) {
  const sub = s.subs.find(x => x.id === op.subId)
  if (sub && op.subPart !== undefined) sub.paidAmt = Math.max(0, Math.round(((sub.paidAmt ?? 0) - op.subPart) * 100) / 100)
  else if (sub) sub.paid = false
  if (sub && op.subDayWas !== undefined) sub.day = op.subDayWas
  op.subDayWas = undefined
  op.subId = undefined
  op.subPart = undefined
}

/**
 * Дата следующего поступления. Если её передвинули в следующий календарный месяц (или дальше) — начался новый месяц:
 * факт расходов обнуляется, галочки подписок снимаются (план остаётся). Прежнее запоминается, чтобы можно было вернуть.
 */
export function setPayday(s: State, date: string) {
  const prev = s.payday
  s.payday = date
  // Сдвиг в пределах того же месяца (вперёд или назад на несколько дней) новым месяцем не считается.
  const ym = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7))
  if (!prev || !date || ym(date) <= ym(prev)) return
  s.lastCycle = {
    at: new Date().toISOString(),
    payday: prev,
    facts: s.expenses.map(r => ({ id: r.id, v: r.amt.v })),
    subs: s.subs.map(x => ({ id: x.id, paid: x.paid, paidAmt: x.paidAmt })),
  }
  s.expenses.forEach(r => (r.amt = { ...r.amt, v: 0 }))
  s.subs.forEach(x => ((x.paid = false), (x.paidAmt = 0)))
}

export function undoNewCycle(s: State) {
  const c = s.lastCycle
  if (!c) return
  s.payday = c.payday
  for (const f of c.facts) {
    const r = s.expenses.find(x => x.id === f.id)
    if (r) r.amt = { ...r.amt, v: f.v }
  }
  for (const o of c.subs) {
    const x = s.subs.find(y => y.id === o.id)
    if (x) Object.assign(x, { paid: o.paid, paidAmt: o.paidAmt })
  }
  s.lastCycle = undefined
}
