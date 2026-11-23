import { bookedLabel } from './autobook'
import { txLabel } from './bank'
import type { Bank, Op, State } from './types'

/** Выписка операций из программы (не официальная выписка банка) — для себя и для разбора. */
export type StatementBank = Bank | 'all'
export interface StatementRow {
  date: string
  bank: Bank
  text: string
  source: 'банк' | 'вручную'
  inc: number
  out: number
  cur: string
  where: string
}

const BANK: Record<Bank, string> = { pko: 'PKO', revolut: 'Revolut' }
const localDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const r2 = (n: number) => Math.round(n * 100) / 100

/** Учтённые операции за период: без отменённых, неопознанных и дублей (уведомление + та же ручная запись). */
export function statementRows(s: State, bank: StatementBank, from: string, to: string): StatementRow[] {
  return s.ops
    .filter((o: Op) => o.status === 'applied' && o.amount !== null && o.dir !== 0)
    .filter(o => bank === 'all' || o.bank === bank)
    .map(o => ({ o, date: localDate(o.at) }))
    .filter(x => x.date >= from && x.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.o.at.localeCompare(b.o.at))
    .map(({ o, date }) => ({
      date,
      bank: o.bank,
      text: o.manual ? o.note || '—' : o.fromBank ? txLabel(o.text) : o.text,
      source: o.manual ? ('вручную' as const) : ('банк' as const),
      inc: o.dir > 0 ? (o.amount as number) : 0,
      out: o.dir < 0 ? (o.amount as number) : 0,
      cur: o.cur,
      where: [bookedLabel(s, o), o.subId ? `подписка «${s.subs.find(x => x.id === o.subId)?.name ?? '—'}»` : ''].filter(Boolean).join(' · '),
    }))
}

/** Итоги по валютам: пришло, ушло, разница. */
export function statementTotals(rows: StatementRow[]) {
  const t: Record<string, { inc: number; out: number; diff: number; count: number }> = {}
  for (const r of rows) {
    const x = (t[r.cur] ??= { inc: 0, out: 0, diff: 0, count: 0 })
    x.inc = r2(x.inc + r.inc)
    x.out = r2(x.out + r.out)
    x.diff = r2(x.inc - x.out)
    x.count++
  }
  return t
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const money = (n: number) => (n ? n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '')
const dmy = (d: string) => d.split('-').reverse().join('.')
const sign: Record<string, string> = { PLN: 'zł', EUR: '€', USD: '$' }

export function statementTitle(bank: StatementBank, from: string, to: string) {
  const who = bank === 'all' ? 'PKO и Revolut' : BANK[bank]
  return `Выписка ${who} ${dmy(from).slice(0, 5)}–${dmy(to)}`
}

/** Страница для печати в PDF — в оформлении программы. */
export function statementHtml(s: State, bank: StatementBank, from: string, to: string, now = new Date()): string {
  const rows = statementRows(s, bank, from, to)
  const title = statementTitle(bank, from, to)
  const banks: Bank[] = bank === 'all' ? ['pko', 'revolut'] : [bank]
  const totalsBlock = (label: string, rs: StatementRow[]) =>
    Object.entries(statementTotals(rs))
      .map(
        ([cur, t]) =>
          `<tr><td>${esc(label)}${cur !== 'PLN' ? ` · ${cur}` : ''}</td><td class="n">${t.count}</td><td class="n pos">+${money(t.inc) || '0,00'}</td><td class="n neg">−${money(t.out) || '0,00'}</td><td class="n"><b>${t.diff >= 0 ? '+' : '−'}${money(Math.abs(t.diff)) || '0,00'} ${sign[cur] ?? cur}</b></td></tr>`,
      )
      .join('')
  const totals = [
    ...(bank === 'all' ? banks.map(b => totalsBlock(BANK[b], rows.filter(r => r.bank === b))) : []),
    totalsBlock(bank === 'all' ? 'Всего' : BANK[bank], rows),
  ].join('')
  const body = rows.length
    ? rows
        .map(
          r =>
            `<tr><td class="nw">${dmy(r.date)}</td><td class="nw">${BANK[r.bank]}</td><td>${esc(r.text)}${r.where ? `<div class="w">${esc(r.where)}</div>` : ''}</td><td class="nw src">${r.source}</td><td class="n pos">${r.inc ? '+' + money(r.inc) : ''}</td><td class="n neg">${r.out ? '−' + money(r.out) : ''}</td><td class="nw">${sign[r.cur] ?? r.cur}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="empty">За этот период операций нет.</td></tr>'
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Onest:wght@400;500&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box}
body{margin:0;font:12px/1.45 Onest,-apple-system,sans-serif;color:#141414;background:#fff}
@media screen{body{padding:24px 28px;max-width:1000px;margin:0 auto}}
.top{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:3px solid #141414;padding-bottom:8px;margin-bottom:6px}
h1{font:700 26px/1 Oswald,'Arial Narrow',sans-serif;text-transform:uppercase;letter-spacing:.04em;margin:0}
h1 span{color:#d62828}
.meta{font-size:12px;text-align:right;color:#5d5a52}
.note{font-size:11px;color:#5d5a52;margin:0 0 12px}
table{width:100%;border-collapse:collapse}
th{font:500 11px Oswald,'Arial Narrow',sans-serif;text-transform:uppercase;letter-spacing:.06em;text-align:left;border-bottom:2px solid #141414;padding:5px 6px}
td{padding:5px 6px;border-bottom:1px solid #ddd5c3;vertical-align:top}
tr{break-inside:avoid}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.nw{white-space:nowrap}
.pos{color:#2f6b2a}.neg{color:#b81f1f}
.src{color:#5d5a52;font-size:11px}
.w{font-size:10.5px;color:#5d5a52;margin-top:1px}
.empty{text-align:center;color:#5d5a52;padding:20px}
h2{font:700 15px Oswald,'Arial Narrow',sans-serif;text-transform:uppercase;letter-spacing:.05em;margin:18px 0 6px;display:flex;align-items:center;gap:8px}
h2:before{content:"";width:10px;height:10px;background:#d62828}
.tot td{font-size:13px}
</style></head><body>
<div class="top"><h1>Выписка <span>операций</span></h1><div class="meta">${esc(bank === 'all' ? 'PKO и Revolut' : BANK[bank])}<br>${dmy(from)} — ${dmy(to)}<br>сформирована ${now.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div></div>
<p class="note">Из программы «Бюджет»: операции из выписок банков и ручные записи. Отменённые операции и дубли не включены. Это не официальная выписка банка.</p>
<table><thead><tr><th>Дата</th><th>Банк</th><th>Описание</th><th>Источник</th><th class="n">Приход</th><th class="n">Расход</th><th></th></tr></thead><tbody>${body}</tbody></table>
<h2>Итоги</h2>
<table class="tot"><thead><tr><th></th><th class="n">Операций</th><th class="n">Пришло</th><th class="n">Ушло</th><th class="n">Разница</th></tr></thead><tbody>${totals || '<tr><td colspan="5" class="empty">—</td></tr>'}</tbody></table>
<script>document.fonts&&document.fonts.ready.then(()=>setTimeout(()=>print(),200))</script>
</body></html>`
}
