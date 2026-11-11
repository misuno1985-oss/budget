import type { Cur, Rates } from './types'

const KEY = 'budget.rates'
// Резерв на случай, если NBP недоступен и в памяти ничего нет.
const FALLBACK: Rates = { PLN: 1, USD: 3.95, EUR: 4.41 }

export interface RatesInfo {
  rates: Rates
  date: string
}

export function cachedRates(): RatesInfo {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (c?.rates) return { rates: { PLN: 1, USD: c.rates.USD ?? FALLBACK.USD, EUR: c.rates.EUR ?? FALLBACK.EUR }, date: c.date ?? '' }
  } catch {}
  return { rates: FALLBACK, date: '' }
}

/** Курсы NBP, таблица A (каждый рабочий день): доллар и евро. */
export async function fetchRates(): Promise<RatesInfo> {
  const [a] = await fetch('https://api.nbp.pl/api/exchangerates/tables/A/?format=json').then(r => r.json())
  const mid = (code: string) => a.rates.find((r: any) => r.code === code)?.mid
  const info: RatesInfo = { rates: { PLN: 1, USD: mid('USD') ?? FALLBACK.USD, EUR: mid('EUR') ?? FALLBACK.EUR }, date: a.effectiveDate }
  try {
    localStorage.setItem(KEY, JSON.stringify(info))
  } catch {}
  return info
}

/**
 * Курс NBP для налога: средний курс за последний рабочий день перед датой поступления.
 * Доллар и евро — таблица A (ежедневно).
 */
export async function nbpRateBefore(cur: Cur, date: string): Promise<{ rate: number; day: string } | null> {
  if (cur === 'PLN' || !date) return null
  const d = new Date(date + 'T12:00:00Z')
  const iso = (x: Date) => x.toISOString().slice(0, 10)
  const to = new Date(d.getTime() - 864e5)
  const from = new Date(d.getTime() - 21 * 864e5)
  try {
    const r = await fetch(`https://api.nbp.pl/api/exchangerates/rates/A/${cur}/${iso(from)}/${iso(to)}/?format=json`)
    if (!r.ok) return null
    const list = (await r.json()).rates as { effectiveDate: string; mid: number }[]
    const last = list[list.length - 1]
    return last ? { rate: last.mid, day: last.effectiveDate } : null
  } catch {
    return null
  }
}
