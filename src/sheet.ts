import { cycleStart, itemPln, parseDate, prepaidLeft, subPln, subRemaining, toPln } from './calc'
import type { Rates, State } from './types'

/**
 * Таблица в раскладке исходного листа пользователя: те же блоки на тех же местах, те же формулы и цвета,
 * только с текущими данными программы. Списки длиннее, чем было в оригинале, растут вниз.
 */
export interface Cell {
  v?: number | string
  /** Формула — по-английски, как её принимает Google Таблицы через API. */
  f?: string
  date?: string
  fmt?: 'dd.mm' | 'dd.mm.yyyy'
  bold?: boolean
  fill?: string
}
export type Grid = Map<string, Cell>

const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const ref = (col: string, row: number) => col + row
const r2 = (n: number) => Math.round(n * 100) / 100
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const RED = '#EA9999'
const GREEN = '#D9EAD3'
const ORANGE = '#F9CB9C'
const CYAN = '#00FFFF'
const TAX_FILLS = ['#CCCCCC', '#00FF00', '#FFFF00']

export function buildGrid(s: State, rates: Rates, today: Date): Grid {
  const g: Grid = new Map()
  const put = (c: string, r: number, cell: Cell) => g.set(ref(c, r), cell)

  // Доходы и расходы месяца.
  put('B', 1, { v: 'Доходы' })
  put('D', 1, { v: 'Расходы' })
  s.incomes.forEach((x, i) => {
    put('A', 2 + i, { v: x.name })
    put('B', 2 + i, { v: r2(toPln(x.amt, rates)), bold: true })
  })
  s.expenses.forEach((x, i) => {
    put('C', 2 + i, { v: x.name })
    if (x.amt.v) put('D', 2 + i, { v: r2(toPln(x.amt, rates)) })
    if (x.plan) put('E', 2 + i, { v: x.plan })
  })

  // Подписки: M — сколько ещё спишется в этом месяце, N — день, O — цена.
  put('L', 1, { v: 'Подписки' })
  put('N', 1, { v: 'Число', fill: GREEN })
  const subTop = 2
  s.subs.forEach((x, i) => {
    const r = subTop + i
    put('L', r, { v: x.name })
    const rest = subRemaining(x, rates)
    if (rest) put('M', r, { v: r2(rest) })
    put('N', r, { v: x.day, fill: GREEN })
    put('O', r, { v: r2(subPln(x, rates)) })
  })
  const subEnd = subTop + Math.max(1, s.subs.length) - 1
  const subTotal = Math.max(14, subEnd + 1)
  put('L', subTotal, { v: 'ИТОГО:' })
  put('M', subTotal, { f: `=SUM(M${subTop}:M${subTotal - 1})` })
  put('O', subTotal, { f: `=SUM(O${subTop}:O${subTotal - 1})` })

  const expEnd = Math.max(1 + s.expenses.length, 11)
  put('C', expEnd + 1, { v: 'Подписки' })
  put('D', expEnd + 1, { f: `=M${subTotal}` })
  put('C', expEnd + 2, { v: 'Снять с карты*' })
  if (s.toCapital) put('D', expEnd + 2, { v: s.toCapital })
  put('C', expEnd + 3, { v: 'ОТЛОЖИТЬ!!!', bold: true })
  const toCapRow = expEnd + 2
  const fromRow = Math.max(expEnd + 3, 1 + s.incomes.length + 1)
  put('A', fromRow, { v: 'Взял из*' })
  if (s.fromCapital) put('B', fromRow, { v: s.fromCapital })
  const sumRow = fromRow + 1
  const totRow = sumRow + 1
  put('B', sumRow, { v: 'Всего', fill: ORANGE })
  put('D', sumRow, { v: 'Итого', fill: ORANGE })
  put('E', sumRow, { v: 'Остаток', fill: ORANGE })
  put('B', totRow, { f: `=SUM(B2:B${sumRow})`, fill: ORANGE })
  put('D', totRow, { f: `=SUM(D2:D${fromRow})`, fill: ORANGE })
  put('E', totRow, { f: `=SUM(B${totRow}-D${totRow})`, fill: ORANGE })
  const rest = `E${totRow}`

  // Сколько можно в день: каждый день месяца бюджета и сколько дней до денег.
  if (s.payday) {
    const pay = parseDate(s.payday)
    const days: Date[] = []
    for (let d = cycleStart(s, today); d <= pay && days.length < 36; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d)
    days.forEach((d, i) => {
      const [c1, c2, c3] = i < 22 ? ['F', 'G', 'H'] : ['I', 'J', 'K']
      const r = i < 22 ? 1 + i : 1 + i - 22
      put(c1, r, { date: iso(d), fmt: 'dd.mm', fill: RED })
      put(c2, r, { v: Math.round((pay.getTime() - d.getTime()) / 864e5) })
      put(c3, r, { f: `=DIVIDE(${rest},${c2}${r})` })
    })
  }

  // Капитал: слева активы, справа долги; «Снять с карты*» и «Взял*» — переносы из месяца.
  const capTop = totRow + 1
  put('A', capTop, { v: 'Снять с карты*' })
  put('B', capTop, { f: `=SUM(D${toCapRow})` })
  s.assets.forEach((x, i) => {
    put('A', capTop + 1 + i, { v: x.name })
    if (x.amt.v) put('B', capTop + 1 + i, { v: r2(toPln(x.amt, rates)), bold: i === 0, fill: i === 0 ? CYAN : undefined })
  })
  if (s.assets[0]) g.get(ref('A', capTop + 1))!.fill = CYAN
  if (s.assets[0]) g.get(ref('A', capTop + 1))!.bold = true
  s.liabilities.forEach((x, i) => {
    put('C', capTop + i, { v: x.name })
    put('D', capTop + i, { v: r2(toPln(x.amt, rates)) })
  })
  const taxRow = capTop + s.liabilities.length
  put('C', taxRow, { v: `Налог ${s.tax.year}` })
  const tookRow = Math.max(taxRow + 1, capTop + 5)
  put('C', tookRow, { v: 'Взял*' })
  put('D', tookRow, { f: `=SUM(B${fromRow})` })
  const capEnd = Math.max(capTop + s.assets.length + 1, tookRow + 1, capTop + 6)
  put('A', capEnd, { v: 'Итого:' })
  put('B', capEnd, { f: `=SUM(B${capTop}:B${capEnd - 1})` })
  put('D', capEnd, { f: `=SUM(D${capTop}:D${capEnd - 1})` })
  put('E', capEnd, { f: `=SUM(B${capEnd}-D${capEnd})` })
  put('E', capEnd + 1, { f: `=E${capEnd}+${r2(prepaidLeft(s.prepaid, today))}` })
  put('G', capEnd, { v: 'Доллар' })
  put('H', capEnd, { v: 'Евро' })
  put('G', capEnd + 1, { f: '=GOOGLEFINANCE("CURRENCY:USDPLN")' })
  put('H', capEnd + 1, { f: '=GOOGLEFINANCE("CURRENCY:EURPLN")' })

  // Квартира: чинш, электричество и найм хозяину по датам, с пометкой.
  const rentHead = capEnd + 1
  put('B', rentHead, { v: 'Чынш' })
  put('C', rentHead, { v: 'Дариуш (электрычносць)' })
  put('D', rentHead, { v: 'Дариуш (найм)' })
  ;[...s.rent]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((p, i) => {
      const r = rentHead + 1 + i
      const big = p.rent > 4000 || !!p.note
      put('A', r, { date: p.date, fmt: 'dd.mm.yyyy' })
      if (p.chynsh) put('B', r, { v: p.chynsh })
      if (p.electr) put('C', r, { v: p.electr, bold: big })
      if (p.rent) put('D', r, { v: p.rent, bold: big })
      if (p.note) put('E', r, { v: `(${p.note})`, bold: true })
    })

  // Покер — выигрыши без налога, жирным в столбце O под подписками.
  s.poker.forEach((p, i) => put('O', Math.max(22, subTotal + 2) + i, { v: p.amount, bold: true }))

  // Налоги: столбцы доходов P, Q, R…, справа — взносы в налоговую с датами и итоги.
  const tc = s.tax.columns
  const taxCols = tc.map((_, i) => COLS[15 + i])
  const payCol = COLS[15 + tc.length]
  const amtCol = COLS[16 + tc.length]
  const dueCol = COLS[17 + tc.length]
  const head = 15
  tc.forEach((c, i) => {
    put(taxCols[i], head, { v: c.name, fill: TAX_FILLS[i % TAX_FILLS.length] })
    put(taxCols[i], head + 1, { v: s.tax.year, fill: TAX_FILLS[i % TAX_FILLS.length] })
    c.items.forEach((x, j) => put(taxCols[i], head + 2 + j, { v: r2(itemPln(x)) }))
  })
  put(payCol, head, { v: `URZĄD SKARBOWY-${String(s.tax.year).slice(2)}`, fill: RED })
  ;[...s.tax.payments]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((p, j) => {
      put(payCol, head + 1 + j, { date: p.date, fmt: 'dd.mm.yyyy' })
      put(amtCol, head + 1 + j, { v: p.amount })
    })
  const longest = Math.max(0, ...tc.map(c => c.items.length), s.tax.payments.length - 1)
  const sums = Math.max(head + 29, head + 2 + longest + 1)
  tc.forEach((_, i) => put(taxCols[i], sums, { f: `=SUM(${taxCols[i]}${head + 2}:${taxCols[i]}${sums - 1})` }))
  // Налог с каждого столбца по его ставке; в оригинале — «патреон + кофе» по 12% и зарплата отдельно.
  const due = tc.map((c, i) => `${taxCols[i]}${sums}*${c.rate}%`).join('+') || '0'
  put(payCol, sums + 1, { v: 'Сумма налога' })
  put(amtCol, sums + 1, { f: `=${due}` })
  put(payCol, sums + 2, { v: 'Заплатил' })
  put(amtCol, sums + 2, { f: `=SUM(${amtCol}${head + 1}:${amtCol}${sums - 1})` })
  put(dueCol, sums + 1, { v: 'осталось' })
  put(dueCol, sums + 2, { f: `=${amtCol}${sums + 1}-${amtCol}${sums + 2}` })
  put('D', taxRow, { f: `=MAX(0,${amtCol}${sums + 1}-${amtCol}${sums + 2})` })

  return g
}

/** Ширина столбцов как в оригинале, пиксели. */
const WIDTHS: Record<string, number> = { A: 132, B: 79, C: 142, D: 75, E: 67, F: 50, G: 46, H: 81, I: 53, J: 72, M: 62, N: 74 }

const rgb = (hex: string) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
})
/** Номер дня для Google Таблиц: дни с 30.12.1899. */
const serial = (d: string) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5)

/** Запрос на создание таблицы (Google Sheets API, spreadsheets.create). */
export function sheetBody(g: Grid, title: string, sheet: string) {
  let maxR = 1
  let maxC = 0
  for (const k of g.keys()) {
    const m = /^([A-Z])(\d+)$/.exec(k)!
    maxR = Math.max(maxR, +m[2])
    maxC = Math.max(maxC, COLS.indexOf(m[1]))
  }
  const rowData = Array.from({ length: maxR }, (_, r) => ({
    values: Array.from({ length: maxC + 1 }, (_, c) => {
      const cell = g.get(ref(COLS[c], r + 1))
      if (!cell) return {}
      const fmt: any = {}
      if (cell.fmt) fmt.numberFormat = { type: 'DATE', pattern: cell.fmt }
      if (cell.bold) fmt.textFormat = { bold: true }
      if (cell.fill) fmt.backgroundColor = rgb(cell.fill)
      const value =
        cell.f !== undefined
          ? { formulaValue: cell.f }
          : cell.date
            ? { numberValue: serial(cell.date) }
            : typeof cell.v === 'number'
              ? { numberValue: cell.v }
              : { stringValue: String(cell.v ?? '') }
      return { userEnteredValue: value, ...(Object.keys(fmt).length ? { userEnteredFormat: fmt } : {}) }
    }),
  }))
  return {
    properties: { title, locale: 'ru_RU', timeZone: 'Europe/Warsaw' },
    sheets: [
      {
        properties: { title: sheet },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData,
            columnMetadata: Array.from({ length: Math.max(maxC + 1, 21) }, (_, c) => (WIDTHS[COLS[c]] ? { pixelSize: WIDTHS[COLS[c]] } : {})),
          },
        ],
      },
    ],
  }
}
