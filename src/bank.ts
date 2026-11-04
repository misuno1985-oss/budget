import { book } from './autobook'
import { markSub } from './state'
import type { Bank, BankAccount, BankFeed, BankTx, Op, Rates, State } from './types'

const DAY = 864e5
const round2 = (n: number) => Math.round(n * 100) / 100
const localDay = (iso: string) => {
  const d = new Date(iso)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}
const txDay = (date: string) => Date.parse(date.slice(0, 10) + 'T00:00:00Z')

/** Свой основной злотый счёт банка в выписке. */
export const mainAccount = (feed: BankFeed | null, bank: Bank) => feed?.accounts.find(a => a.role === bank)

/** Доступ к банку скоро закончится (или уже закончился): сколько дней осталось. */
export function sessionDaysLeft(feed: BankFeed | null, now = Date.now()) {
  return Object.entries(feed?.sessions ?? {}).map(([bank, s]) => ({ bank, days: Math.floor((Date.parse(s.valid_until) - now) / DAY) }))
}

/**
 * Уведомление или ручная запись, которой соответствует операция из выписки: тот же банк, та же сумма и направление,
 * банк провёл её не раньше чем за день до уведомления и не позже чем через неделю (карты PKO проводятся через 1–3 дня).
 */
function findOp(s: State, bank: Bank, tx: BankTx, liveIds: Set<string>): Op | undefined {
  const d = txDay(tx.date)
  return s.ops
    .filter(o => o.bank === bank && o.status !== 'matched' && o.amount !== null && o.cur === 'PLN' && Math.abs(o.amount - tx.amount) < 0.005)
    .filter(o => !o.bankTx || (o.bankPending && !liveIds.has(o.bankTx)))
    .filter(o => (o.dir === 0 || o.dir === tx.dir) && d - localDay(o.at) >= -DAY && d - localDay(o.at) <= 7 * DAY)
    .sort((a, b) => Number(b.status === 'applied') - Number(a.status === 'applied') || Math.abs(localDay(a.at) - d) - Math.abs(localDay(b.at) - d))[0]
}

function syncAccount(s: State, bank: Bank, acc: BankAccount, since: string, rates: Rates, seq: { n: number }) {
  const live = new Set(acc.tx.map(t => t.id))
  const txs = acc.tx.filter(t => t.cur === 'PLN' && t.date.slice(0, 10) >= since).sort((a, b) => a.date.localeCompare(b.date))
  for (const tx of txs) {
    const known = s.ops.find(o => o.bankTx === tx.id && o.bank === bank)
    if (known) {
      known.bankPending = tx.pending
      continue
    }
    const op = findOp(s, bank, tx, live)
    if (op) {
      op.bankTx = tx.id
      op.bankPending = tx.pending
      continue
    }
    // Уведомление не пришло: операция из выписки. Остаток не трогаем — он ниже берётся из банка целиком.
    const added: Op = {
      id: -(Date.parse(acc.at) + seq.n++),
      at: tx.date.slice(0, 10) + 'T12:00:00',
      bank,
      text: tx.text,
      amount: tx.amount,
      cur: 'PLN',
      dir: tx.dir,
      status: 'applied',
      pln: 0,
      fromBank: true,
      bankTx: tx.id,
      bankPending: tx.pending,
    }
    markSub(s, added, rates)
    book(s, added)
    s.ops.push(added)
  }

  // Остаток — как в банке на момент выписки плюс уведомления, пришедшие уже после неё.
  const row = [...s.incomes, ...s.assets].find(r => r.id === s.bankLinks[bank])
  if (row && row.amt.cur === 'PLN') {
    const after = s.ops
      .filter(o => o.bank === bank && o.status === 'applied' && !o.fromBank && !o.bankTx && o.pln && Date.parse(o.at) > Date.parse(acc.at))
      .reduce((a, o) => a + (o.pln ?? 0), 0)
    row.amt = { ...row.amt, v: round2(acc.available + after) }
  }
}

/** Учесть новую выписку банка: дописать пропущенные операции и выровнять остатки. Возвращает новое состояние. */
export function reconcile(prev: State, feed: BankFeed, rates: Rates): State {
  if (!feed?.fetchedAt || prev.bankSync?.fetchedAt === feed.fetchedAt) return prev
  const s: State = structuredClone(prev)
  // Первая выписка: прошлое уже учтено вручную. Карты PKO проводятся через 1–3 дня с датой проведения,
  // поэтому операции без уведомления добавляем только через 3 дня после подключения — остатки выравниваются сразу.
  const since = s.bankSync?.since ?? new Date(Date.parse(feed.fetchedAt.slice(0, 10)) + 3 * DAY).toISOString().slice(0, 10)
  const seq = { n: 0 }
  for (const bank of ['pko', 'revolut'] as Bank[]) {
    const acc = mainAccount(feed, bank)
    if (acc) syncAccount(s, bank, acc, since, rates, seq)
  }
  s.ops.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  s.bankSync = { since, fetchedAt: feed.fetchedAt }
  return s
}

const CODES: [RegExp, string][] = [
  [/MOBILE-PAYMENT-POS-NO-CARD[\w-]*/i, 'BLIK в магазине'],
  [/MOBILE-PAYMENT-POS[\w-]*/i, 'оплата телефоном'],
  [/MOBILE-PAYMENT-P2P[\w-]*|PHONE-TRANSFER[\w-]*/i, 'перевод на телефон'],
  [/CASH-IN-ATM/i, 'внесение наличных'],
  [/CASH-OUT-ATM|ATM-WITHDRAWAL/i, 'снятие в банкомате'],
  [/TRANSFER-IN/i, 'перевод'],
  [/TRANSFER-OUT/i, 'перевод'],
  [/CARD-PAYMENT/i, ''],
]
const CITY = /^(warszawa|krakow|kraków|gdansk|gdańsk|wroclaw|wrocław|poznan|poznań|lodz|łódź|vilnius|london|dublin|berlin|amsterdam)(?=[A-ZĄĆĘŁŃÓŚŹŻ])/i

/** Читаемое описание операции из выписки: без служебных кодов банка, длинных номеров и склеенного города. */
export function txLabel(text: string): string {
  const parts = text
    .split(' · ')
    .map(p => {
      for (const [re, name] of CODES) if (re.test(p)) return name
      if (/^\d{10,}$/.test(p.trim())) return ''
      return p.replace(CITY, '').replace(/(?<=[\w.)])([A-Z]{2})$/, '').replace(/\s{2,}/g, ' ').trim()
    })
    .filter(Boolean)
  return [...new Set(parts)].join(' · ') || '—'
}
